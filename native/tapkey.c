// tapkey: posts synthetic key events for claude-micro.
// Adapted from alasano/house-of-herdr packages/codex-micro/src/tapkey.c
// (MIT, Copyright (c) 2026 Aljosa Asanovic). See THIRD_PARTY.md.
// Additions: "front" prints the frontmost app's bundle id; an optional
// allow-list of bundle ids gates key posting on the frontmost app.
//
// tapkey <keycode> [tap|down|up|check] [modifier-mask]: posts synthetic key
// events. `tapkey scroll <lines>` behaves like a system mouse wheel;
// optional window coordinates move to and target a specific app pane.
// Modifier mask bits (shared with keys.ts): 1=cmd 2=shift 4=alt 8=ctrl,
// applied as event flags so combos like cmd+shift+p work. Bare modifier keycodes
// (cmd/shift/alt/ctrl, left and right) post flagsChanged events carrying the
// device-specific flag, which apps triggering on a bare modifier press listen
// for. "check" only verifies the Accessibility permission. Requires
// Accessibility to post.
#include <ApplicationServices/ApplicationServices.h>
#include <errno.h>
#include <math.h>
#include <objc/message.h>
#include <objc/runtime.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

// kCGEventFlagMaskNonCoalesced. The SDK documents this bit for mouse and pen
// movement, but the value comes from captures of the vendor app's own key
// synthesis and is what the working hold path posts today, so it stays.
#define FLAG_NON_COALESCED 0x100

#define MODIFIER_MASK_MAX 15
#define KEYCODE_MAX 0xffff
#define SCROLL_LINES_MAX 120
#define SCROLL_EVENT_GAP_US 20000
#define POINTER_SETTLE_US 30000
#define TAP_HOLD_US 30000

// kVK_* modifier keycodes with their event flag and NX device-specific bit.
static const struct {
  CGKeyCode code;
  CGEventFlags flag;
  CGEventFlags deviceFlag;
} MODIFIERS[] = {
    {54, kCGEventFlagMaskCommand, 0x10},   // right command
    {55, kCGEventFlagMaskCommand, 0x08},   // left command
    {56, kCGEventFlagMaskShift, 0x02},     // left shift
    {58, kCGEventFlagMaskAlternate, 0x20}, // left option
    {59, kCGEventFlagMaskControl, 0x01},   // left control
    {60, kCGEventFlagMaskShift, 0x04},     // right shift
    {61, kCGEventFlagMaskAlternate, 0x40}, // right option
    {62, kCGEventFlagMaskControl, 0x2000}, // right control
    {63, kCGEventFlagMaskSecondaryFn, 0},  // fn / globe (claude-micro addition)
};

static CGEventFlags mask_to_flags(int mask) {
  CGEventFlags flags = 0;
  if (mask & 1) flags |= kCGEventFlagMaskCommand;
  if (mask & 2) flags |= kCGEventFlagMaskShift;
  if (mask & 4) flags |= kCGEventFlagMaskAlternate;
  if (mask & 8) flags |= kCGEventFlagMaskControl;
  return flags;
}

static bool parse_long(const char *text, long min, long max, long *out) {
  char *end = NULL;
  errno = 0;
  long value = strtol(text, &end, 10);
  if (errno != 0 || end == text || *end != '\0' || value < min || value > max) {
    return false;
  }
  *out = value;
  return true;
}

static bool parse_fraction(const char *text, double *out) {
  char *end = NULL;
  errno = 0;
  double value = strtod(text, &end);
  // NaN slips through plain range comparisons, so demand a finite value.
  if (errno != 0 || end == text || *end != '\0' || !isfinite(value) ||
      value < 0.0 || value > 1.0) {
    return false;
  }
  *out = value;
  return true;
}

// The application holding user focus, via NSWorkspace through the Objective-C
// runtime (tapkey stays a C file). Window z-order is not focus: background
// utilities (Dell's DDPM, overlays) keep permanent layer-0 windows at the top
// of the on-screen list. NSWorkspace needs no permission, unlike the
// accessibility system-wide focus query, which fails with cannotComplete in
// some launch contexts even for a trusted process.
static pid_t focused_app_pid(void) {
  typedef id (*msg_id)(id, SEL);
  typedef int (*msg_int)(id, SEL);
  id workspace = ((msg_id)objc_msgSend)((id)objc_getClass("NSWorkspace"),
                                        sel_registerName("sharedWorkspace"));
  if (workspace == NULL) return 0;
  id app = ((msg_id)objc_msgSend)(workspace,
                                  sel_registerName("frontmostApplication"));
  if (app == NULL) return 0;
  return (pid_t)((msg_int)objc_msgSend)(app,
                                        sel_registerName("processIdentifier"));
}

// Bundle identifier of the application holding user focus ("" if none).
static void focused_bundle_id(char *out, size_t size) {
  typedef id (*msg_id)(id, SEL);
  typedef const char *(*msg_cstr)(id, SEL);
  out[0] = 0;
  id workspace = ((msg_id)objc_msgSend)((id)objc_getClass("NSWorkspace"),
                                        sel_registerName("sharedWorkspace"));
  if (workspace == NULL) return;
  id app = ((msg_id)objc_msgSend)(workspace,
                                  sel_registerName("frontmostApplication"));
  if (app == NULL) return;
  id bundle = ((msg_id)objc_msgSend)(app, sel_registerName("bundleIdentifier"));
  if (bundle == NULL) return;
  const char *text = ((msg_cstr)objc_msgSend)(bundle, sel_registerName("UTF8String"));
  if (text != NULL) strlcpy(out, text, size);
}

// True when the frontmost app's bundle id is in the comma-separated list.
static bool front_allowed(const char *allow) {
  char front[256];
  focused_bundle_id(front, sizeof front);
  if (front[0] == 0) return false;
  const char *p = allow;
  while (*p) {
    const char *end = strchr(p, ',');
    size_t len = end ? (size_t)(end - p) : strlen(p);
    if (len == strlen(front) && strncmp(p, front, len) == 0) return true;
    if (!end) break;
    p = end + 1;
  }
  return false;
}

// Find the frontmost on-screen, normal-layer window owned by the requested
// terminal app. CGWindowList is front-to-back, so the first match is the
// terminal's key window when the terminal is the focused application.
static bool find_window(const char *owner, pid_t *pid, CGRect *bounds) {
  CFStringRef wanted = CFStringCreateWithCString(
      kCFAllocatorDefault, owner, kCFStringEncodingUTF8);
  if (wanted == NULL) return false;
  CFArrayRef windows = CGWindowListCopyWindowInfo(
      kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
      kCGNullWindowID);
  if (windows == NULL) {
    CFRelease(wanted);
    return false;
  }
  bool found = false;
  CFIndex count = CFArrayGetCount(windows);
  for (CFIndex i = 0; i < count && !found; i++) {
    CFDictionaryRef window =
        (CFDictionaryRef)CFArrayGetValueAtIndex(windows, i);
    int64_t layer = -1;
    CFNumberRef layer_number =
        (CFNumberRef)CFDictionaryGetValue(window, kCGWindowLayer);
    if (layer_number == NULL ||
        !CFNumberGetValue(layer_number, kCFNumberSInt64Type, &layer) ||
        layer != 0) {
      continue;
    }
    CFNumberRef pid_number =
        (CFNumberRef)CFDictionaryGetValue(window, kCGWindowOwnerPID);
    int64_t owner_pid = 0;
    if (pid_number == NULL ||
        !CFNumberGetValue(pid_number, kCFNumberSInt64Type, &owner_pid) ||
        owner_pid <= 0) {
      continue;
    }
    CFStringRef actual =
        (CFStringRef)CFDictionaryGetValue(window, kCGWindowOwnerName);
    if (actual == NULL ||
        CFStringCompare(actual, wanted, kCFCompareCaseInsensitive) !=
            kCFCompareEqualTo) {
      continue;
    }
    CFDictionaryRef bounds_dictionary =
        (CFDictionaryRef)CFDictionaryGetValue(window, kCGWindowBounds);
    if (bounds_dictionary == NULL ||
        !CGRectMakeWithDictionaryRepresentation(bounds_dictionary, bounds)) {
      continue;
    }
    *pid = (pid_t)owner_pid;
    found = true;
  }
  CFRelease(windows);
  CFRelease(wanted);
  return found;
}

static bool emit_scroll(int32_t lines, CGPoint location) {
  const int32_t delta = lines > 0 ? 1 : -1;
  const int32_t event_count = lines > 0 ? lines : -lines;
  for (int32_t i = 0; i < event_count; i++) {
    CGEventRef event = CGEventCreateScrollWheelEvent(
        NULL, kCGScrollEventUnitLine, 1, delta);
    if (event == NULL) {
      fprintf(stderr, "could not create scroll event\n");
      return false;
    }
    CGEventSetLocation(event, location);
    // HID-level delivery lets terminal emulators translate the event into
    // either host scrollback or TUI mouse input. The committed pointer
    // position routes it to the intended virtual pane.
    CGEventPost(kCGHIDEventTap, event);
    CFRelease(event);
    if (i + 1 < event_count) usleep(SCROLL_EVENT_GAP_US);
  }
  return true;
}

static bool post_scroll(int32_t lines, double x_fraction, double y_fraction,
                        const char *owner) {
  pid_t pid = 0;
  CGRect bounds = CGRectZero;
  const bool found_window = find_window(owner, &pid, &bounds);
  const bool owner_is_front = found_window && focused_app_pid() == pid;

  CGPoint location = CGPointZero;
  CGPoint original = CGPointZero;
  bool restore = false;
  if (owner_is_front) {
    CGEventRef here = CGEventCreate(NULL);
    if (here != NULL) {
      original = CGEventGetLocation(here);
      restore = true;
      CFRelease(here);
    }
    // Herdr knows which split has keyboard focus. Route the wheel event to
    // that pane even when the pointer is parked over another one. Ghostty
    // routes wheel input using its last committed pointer position rather
    // than the location attached to the scroll event itself, so commit the
    // move before sending the first wheel notch.
    location =
        CGPointMake(bounds.origin.x + bounds.size.width * x_fraction,
                    bounds.origin.y + bounds.size.height * y_fraction);
    CGWarpMouseCursorPosition(location);
    CGEventRef move_event = CGEventCreateMouseEvent(
        NULL, kCGEventMouseMoved, location, kCGMouseButtonLeft);
    if (move_event != NULL) {
      CGEventPost(kCGHIDEventTap, move_event);
      CFRelease(move_event);
    }
    usleep(POINTER_SETTLE_US);
  } else {
    // In every other app, preserve normal macOS wheel behavior.
    CGEventRef cursor_event = CGEventCreate(NULL);
    if (cursor_event == NULL) {
      fprintf(stderr, "could not read pointer location\n");
      return false;
    }
    location = CGEventGetLocation(cursor_event);
    CFRelease(cursor_event);
  }
  const bool ok = emit_scroll(lines, location);
  // The warp was only to aim the wheel; hand the pointer back where it was.
  if (restore) {
    usleep(POINTER_SETTLE_US);
    CGWarpMouseCursorPosition(original);
  }
  return ok;
}

static bool post_system_scroll(int32_t lines) {
  CGEventRef cursor_event = CGEventCreate(NULL);
  if (cursor_event == NULL) {
    fprintf(stderr, "could not read pointer location\n");
    return false;
  }
  const CGPoint location = CGEventGetLocation(cursor_event);
  CFRelease(cursor_event);
  return emit_scroll(lines, location);
}

static bool post(CGKeyCode code, bool down, CGEventFlags flags) {
  CGEventRef event = CGEventCreateKeyboardEvent(NULL, code, down);
  if (event == NULL) {
    fprintf(stderr, "could not create a keyboard event for keycode %u\n", code);
    return false;
  }
  for (size_t i = 0; i < sizeof(MODIFIERS) / sizeof(MODIFIERS[0]); i++) {
    if (MODIFIERS[i].code == code) {
      CGEventSetType(event, kCGEventFlagsChanged);
      CGEventSetFlags(event, down ? MODIFIERS[i].flag | MODIFIERS[i].deviceFlag
                                  : FLAG_NON_COALESCED);
      CGEventPost(kCGHIDEventTap, event);
      CFRelease(event);
      return true;
    }
  }
  // Both edges carry the combo's modifiers. Setting them only on the press
  // left the matching release without them, so an app watching for the end of
  // a held combo saw a different event than the one that started it.
  if (flags != 0) {
    CGEventSetFlags(event, flags | FLAG_NON_COALESCED);
  }
  CGEventPost(kCGHIDEventTap, event);
  CFRelease(event);
  return true;
}

// Left-hand modifier keycodes in the order a person usually presses them,
// with the flag each one contributes. A combo's modifiers are pressed as
// real flagsChanged events before the key and released after it, so the app
// sees the same sequence a keyboard produces instead of a bare key carrying
// modifier flags out of nowhere.
static const struct {
  int bit;
  CGKeyCode code;
  CGEventFlags flag;
} COMBO_MODIFIERS[] = {
    {8, 59, kCGEventFlagMaskControl},
    {4, 58, kCGEventFlagMaskAlternate},
    {2, 56, kCGEventFlagMaskShift},
    {1, 55, kCGEventFlagMaskCommand},
};
#define COMBO_MODIFIER_COUNT 4
#define MODIFIER_STEP_US 8000

static void post_modifiers(int mask, bool down) {
  CGEventFlags held = down ? 0 : mask_to_flags(mask);
  for (int step = 0; step < COMBO_MODIFIER_COUNT; step++) {
    int i = down ? step : COMBO_MODIFIER_COUNT - 1 - step;
    if (!(mask & COMBO_MODIFIERS[i].bit)) continue;
    if (down) held |= COMBO_MODIFIERS[i].flag;
    else held &= ~COMBO_MODIFIERS[i].flag;
    CGEventRef event = CGEventCreateKeyboardEvent(NULL, COMBO_MODIFIERS[i].code, down);
    if (event == NULL) continue;
    CGEventSetType(event, kCGEventFlagsChanged);
    CGEventSetFlags(event, held | FLAG_NON_COALESCED);
    CGEventPost(kCGHIDEventTap, event);
    CFRelease(event);
    usleep(MODIFIER_STEP_US);
  }
}

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr,
            "usage: tapkey <keycode> [tap|down|up|check] [modifier-mask] [allowed-bundle-ids]\n"
            "       tapkey front | tapkey 0 check | tapkey prompt\n"
            "       tapkey scroll <lines>\n"
            "       tapkey scroll <lines> <x-fraction> <y-fraction> "
            "<window-owner>\n");
    return 2;
  }
  // "prompt": ask macOS to show the Accessibility permission dialog, which
  // also adds this process's responsible app to the Accessibility list.
  if (strcmp(argv[1], "prompt") == 0) {
    const void *keys[] = {kAXTrustedCheckOptionPrompt};
    const void *values[] = {kCFBooleanTrue};
    CFDictionaryRef options = CFDictionaryCreate(
        kCFAllocatorDefault, keys, values, 1, &kCFTypeDictionaryKeyCallBacks,
        &kCFTypeDictionaryValueCallBacks);
    bool trusted = AXIsProcessTrustedWithOptions(options);
    CFRelease(options);
    printf("%s\n", trusted ? "accessibility already granted"
                            : "accessibility dialog requested; grant it in System Settings");
    return trusted ? 0 : 3;
  }
  if (strcmp(argv[1], "front") == 0) {
    char front[256];
    focused_bundle_id(front, sizeof front);
    printf("%s\n", front);
    return 0;
  }
  if (strcmp(argv[1], "scroll") == 0) {
    long lines = 0;
    if (argc == 3 &&
        parse_long(argv[2], -SCROLL_LINES_MAX, SCROLL_LINES_MAX, &lines) &&
        lines != 0) {
      if (!AXIsProcessTrusted()) {
        fprintf(stderr, "accessibility permission not granted\n");
        return 3;
      }
      return post_system_scroll((int32_t)lines) ? 0 : 4;
    }
    double x_fraction = 0.0;
    double y_fraction = 0.0;
    if (argc != 6 ||
        !parse_long(argv[2], -SCROLL_LINES_MAX, SCROLL_LINES_MAX, &lines) ||
        lines == 0 || !parse_fraction(argv[3], &x_fraction) ||
        !parse_fraction(argv[4], &y_fraction) || argv[5][0] == '\0') {
      fprintf(stderr,
              "usage: tapkey scroll <nonzero-lines> [<x-fraction> "
              "<y-fraction> <window-owner>]\n");
      return 2;
    }
    if (!AXIsProcessTrusted()) {
      fprintf(stderr, "accessibility permission not granted\n");
      return 3;
    }
    return post_scroll((int32_t)lines, x_fraction, y_fraction, argv[5]) ? 0
                                                                       : 4;
  }
  const char *mode = argc > 2 ? argv[2] : "tap";
  const bool is_check = strcmp(mode, "check") == 0;
  // Silently tapping on a typo would be worse than refusing.
  if (!is_check && strcmp(mode, "tap") != 0 && strcmp(mode, "down") != 0 &&
      strcmp(mode, "up") != 0) {
    fprintf(stderr, "unknown mode: %s\n", mode);
    return 2;
  }

  // Arguments are validated before the permission check, so a malformed call
  // is reported as a malformed call whatever the Accessibility state is.
  // "check" is exempt: callers pass a dummy keycode.
  long keycode = 0;
  long mask = 0;
  if (!is_check) {
    if (!parse_long(argv[1], 0, KEYCODE_MAX, &keycode)) {
      fprintf(stderr, "invalid keycode: %s\n", argv[1]);
      return 2;
    }
    if (argc > 3 && !parse_long(argv[3], 0, MODIFIER_MASK_MAX, &mask)) {
      fprintf(stderr, "invalid modifier mask: %s\n", argv[3]);
      return 2;
    }
  }

  if (!AXIsProcessTrusted()) {
    fprintf(stderr, "accessibility permission not granted\n");
    return 3;
  }
  if (is_check) return 0;

  // With an allow-list, only post while one of those apps is frontmost.
  // Exit 5 tells the caller the key was withheld, not that it failed.
  if (argc > 4 && argv[4][0] != '\0' && !front_allowed(argv[4])) {
    char front[256];
    focused_bundle_id(front, sizeof front);
    fprintf(stderr, "withheld: frontmost app is %s\n", front[0] ? front : "(none)");
    return 5;
  }

  CGKeyCode code = (CGKeyCode)keycode;
  CGEventFlags flags = mask_to_flags((int)mask);
  if (strcmp(mode, "down") == 0) {
    post_modifiers((int)mask, true);
    if (!post(code, true, flags)) return 4;
  } else if (strcmp(mode, "up") == 0) {
    if (!post(code, false, flags)) return 4;
    post_modifiers((int)mask, false);
  } else {
    post_modifiers((int)mask, true);
    if (!post(code, true, flags)) return 4;
    usleep(TAP_HOLD_US);
    if (!post(code, false, flags)) return 4;
    post_modifiers((int)mask, false);
  }
  return 0;
}
