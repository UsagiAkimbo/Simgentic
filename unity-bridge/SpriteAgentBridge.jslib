// Unity WebGL native plugin — exposes JS-side callbacks to Unity C#.
//
// Place this file in your Unity project at:
//   Assets/Plugins/WebGL/SpriteAgentBridge.jslib
//
// Corresponds to the [DllImport("__Internal")] declarations in BridgeReceiver.cs.

mergeInto(LibraryManager.library, {
  JS_OnUnityReady: function () {
    try {
      if (typeof window !== 'undefined' &&
          window.spriteAgent &&
          typeof window.spriteAgent.onUnityReady === 'function') {
        window.spriteAgent.onUnityReady();
      } else {
        console.warn('[SpriteAgentBridge] onUnityReady called but no host handler is registered.');
      }
    } catch (e) {
      console.error('[SpriteAgentBridge] JS_OnUnityReady failed:', e);
    }
  },

  // Unity -> JS: a UI interaction happened in the Unity overlay (radial menu,
  // panels, model picker). `jsonPtr` is a UTF-8 JSON string of shape:
  //   { "action": "model.select", "value": "claude-sonnet-4-5" }
  // Forwarded to window.spriteAgent.onUiEvent(parsed) if registered.
  // Corresponds to JS_OnUiEvent in UIOverlayController.cs.
  JS_OnUiEvent: function (jsonPtr) {
    try {
      var json = UTF8ToString(jsonPtr);
      var payload;
      try {
        payload = JSON.parse(json);
      } catch (parseErr) {
        console.error('[SpriteAgentBridge] JS_OnUiEvent received invalid JSON:', json);
        return;
      }
      if (typeof window !== 'undefined' &&
          window.spriteAgent &&
          typeof window.spriteAgent.onUiEvent === 'function') {
        window.spriteAgent.onUiEvent(payload);
      } else {
        console.warn('[SpriteAgentBridge] onUiEvent called but no host handler is registered:', payload);
      }
    } catch (e) {
      console.error('[SpriteAgentBridge] JS_OnUiEvent failed:', e);
    }
  },
});
