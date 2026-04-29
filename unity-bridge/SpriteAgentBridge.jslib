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
});
