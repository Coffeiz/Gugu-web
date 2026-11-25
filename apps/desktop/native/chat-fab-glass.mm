#import <AppKit/AppKit.h>
#import <objc/message.h>
#include <node_api.h>
#include <cstring>

static napi_value SetChatFabGlass(napi_env env, napi_callback_info info) {
  napi_value args[2];
  size_t count = 2;
  void *bytes = nullptr;
  size_t length = 0;
  bool visible = false;
  bool applied = false;

  if (napi_get_cb_info(env, info, &count, args, nullptr, nullptr) == napi_ok &&
      count == 2 &&
      napi_get_buffer_info(env, args[0], &bytes, &length) == napi_ok &&
      length == sizeof(void *) &&
      napi_get_value_bool(env, args[1], &visible) == napi_ok &&
      [NSThread isMainThread]) {
    void *handle = nullptr;
    std::memcpy(&handle, bytes, sizeof(handle));
    NSView *host = [(__bridge NSView *)handle window].contentView;
    if (host != nil) {
      NSUserInterfaceItemIdentifier identifier = @"gugu.chat-fab-glass";
      for (NSView *child in host.subviews) {
        if ([child.identifier isEqualToString:identifier]) {
          [child removeFromSuperview];
          break;
        }
      }
      if (visible) {
        const CGFloat diameter = 50;
        const NSRect bounds = host.bounds;
        const NSRect frame = NSMakeRect(NSMidX(bounds) - diameter / 2,
                                        NSMidY(bounds) - diameter / 2,
                                        diameter, diameter);
        NSVisualEffectView *glass = [[NSVisualEffectView alloc] initWithFrame:frame];
        glass.identifier = identifier;
        glass.material = NSVisualEffectMaterialPopover;
        glass.blendingMode = NSVisualEffectBlendingModeBehindWindow;
        glass.state = NSVisualEffectStateActive;
        glass.maskImage = [NSImage imageWithSize:frame.size flipped:NO drawingHandler:^BOOL(NSRect rect) {
          [NSColor.blackColor setFill];
          [[NSBezierPath bezierPathWithOvalInRect:rect] fill];
          return YES;
        }];
        [host addSubview:glass positioned:NSWindowBelow relativeTo:nil];
      }
      applied = true;
    }
  }
  napi_value result;
  napi_get_boolean(env, applied, &result);
  return result;
}

// macOS 27 的非激活面板仍可能在鼠标按下时激活应用。仅在该系统版本使用此兼容处理。
static napi_value PreventChatFabActivation(napi_env env, napi_callback_info info) {
  napi_value argument;
  size_t count = 1;
  void *bytes = nullptr;
  size_t length = 0;
  bool applied = false;
  if (@available(macOS 27.0, *)) {
    if (napi_get_cb_info(env, info, &count, &argument, nullptr, nullptr) == napi_ok &&
        count == 1 && napi_get_buffer_info(env, argument, &bytes, &length) == napi_ok &&
        length == sizeof(void *) && [NSThread isMainThread]) {
      void *handle = nullptr;
      std::memcpy(&handle, bytes, sizeof(handle));
      NSWindow *window = [(__bridge NSView *)handle window];
      SEL selector = NSSelectorFromString(@"_setPreventsActivation:");
      if ([window respondsToSelector:selector]) {
        reinterpret_cast<void (*)(id, SEL, BOOL)>(objc_msgSend)(window, selector, YES);
        applied = true;
      }
    }
  }
  napi_value result;
  napi_get_boolean(env, applied, &result);
  return result;
}

NAPI_MODULE_INIT() {
  napi_value setter;
  napi_create_function(env, "setChatFabGlass", NAPI_AUTO_LENGTH, SetChatFabGlass, nullptr, &setter);
  napi_set_named_property(env, exports, "setChatFabGlass", setter);
  napi_create_function(env, "preventChatFabActivation", NAPI_AUTO_LENGTH, PreventChatFabActivation, nullptr, &setter);
  napi_set_named_property(env, exports, "preventChatFabActivation", setter);
  return exports;
}
