using System;
using System.Runtime.InteropServices;
using UnityEngine;

/// <summary>
/// Minimal bridge between the Next.js host and Unity WebGL.
///
/// Setup (one-time):
///   1. Create an empty GameObject in your scene, rename it EXACTLY to "BridgeReceiver".
///   2. Attach this script to it.
///   3. For Sprint A verification, also create a Cube in the scene named "TestCube".
///      SetAgentState will tint it a different color per state so you can see the
///      bridge working before any character/animation work.
///
/// The host calls this from JavaScript via:
///   unityInstance.SendMessage("BridgeReceiver", "SetAgentState",
///     JSON.stringify({ state: "thinking", detail: "" }));
///
/// Unity signals it's alive via JS_OnUnityReady (declared in SpriteAgentBridge.jslib).
/// </summary>
public class BridgeReceiver : MonoBehaviour
{
#if UNITY_WEBGL && !UNITY_EDITOR
    [DllImport("__Internal")]
    private static extern void JS_OnUnityReady();
#endif

    [Serializable]
    public class AgentStateMessage
    {
        public string state;
        public string detail;
    }

    public enum AgentState
    {
        Idle,
        Thinking,
        Searching,
        Reading,
        Answering,
        Done,
        Error,
        Unknown,
    }

    [Header("Optional Sprint A proof-of-bridge target")]
    [Tooltip("If present in the scene, its color will change per state.")]
    public Renderer testCubeRenderer;

    [Header("Sprint D Phase 6: dual camera mode")]
    [Tooltip("Wire the scene's CameraController here. SetCameraMode() forwards to it. Optional — auto-found at Awake if unset.")]
    [SerializeField] CameraController cameraController;

    [Header("Sprint E: Cowork overlay UI")]
    [Tooltip("Wire the OverlayCanvas's UIOverlayController here. SetUiState() forwards to it. Optional — auto-found at Awake if unset.")]
    [SerializeField] UIOverlayController overlayController;

    public AgentState CurrentState { get; private set; } = AgentState.Idle;
    public string CurrentDetail { get; private set; } = string.Empty;

    /// <summary>Fires every time SetAgentState is called from JS.</summary>
    public event Action<AgentState, string> OnStateChanged;

    void Awake()
    {
        // Name must match what JS SendMessage targets.
        gameObject.name = "BridgeReceiver";

        if (testCubeRenderer == null)
        {
            var cube = GameObject.Find("TestCube");
            if (cube != null) testCubeRenderer = cube.GetComponent<Renderer>();
        }

        if (cameraController == null)
        {
            cameraController = FindObjectOfType<CameraController>();
        }

        if (overlayController == null)
        {
            overlayController = FindObjectOfType<UIOverlayController>();
        }
    }

    void Start()
    {
#if UNITY_WEBGL && !UNITY_EDITOR
        // Don't steal keyboard input or focus from other DOM elements (e.g.
        // the <input> field in app/agent/page.tsx). Without this, Unity's
        // default WebGL input behavior pulls focus back to the canvas every
        // time a form field gains it, making nearby HTML inputs un-typeable.
        WebGLInput.captureAllKeyboardInput = false;

        try { JS_OnUnityReady(); }
        catch (Exception e) { Debug.LogWarning($"[Bridge] JS_OnUnityReady failed: {e.Message}"); }
#else
        Debug.Log("[Bridge] Editor play — JS bridge is a no-op here. Test with a WebGL build.");
#endif
    }

    /// <summary>
    /// Called from the host. Arg is a JSON string of AgentStateMessage shape.
    /// </summary>
    public void SetAgentState(string json)
    {
        AgentStateMessage msg;
        try
        {
            msg = JsonUtility.FromJson<AgentStateMessage>(json);
        }
        catch (Exception e)
        {
            Debug.LogError($"[Bridge] Invalid JSON: {e.Message} raw={json}");
            return;
        }

        if (msg == null || string.IsNullOrEmpty(msg.state))
        {
            Debug.LogError($"[Bridge] Empty state in message: {json}");
            return;
        }

        var parsed = ParseState(msg.state);
        CurrentState = parsed;
        CurrentDetail = msg.detail ?? string.Empty;

        Debug.Log($"[Bridge] state={parsed} detail=\"{CurrentDetail}\"");

        // Proof-of-bridge visual for Sprint A. Remove once you have a real character.
        if (testCubeRenderer != null)
        {
            var color = ColorForState(parsed);
            var mat = testCubeRenderer.material; // instances the material on first access

            // URP shaders (Lit/Unlit) expose color as "_BaseColor".
            // Built-in / Standard shaders expose it as "_Color".
            // Set whichever the current shader actually has — the other call is a no-op.
            bool wrote = false;
            if (mat.HasProperty("_BaseColor"))
            {
                mat.SetColor("_BaseColor", color);
                wrote = true;
            }
            if (mat.HasProperty("_Color"))
            {
                mat.SetColor("_Color", color);
                wrote = true;
            }
            if (!wrote)
            {
                Debug.LogWarning(
                    $"[Bridge] Material '{mat.name}' has neither _BaseColor nor _Color. " +
                    "Switch the cube's shader to URP/Unlit or Standard.");
            }
        }

        OnStateChanged?.Invoke(parsed, CurrentDetail);
    }

    /// <summary>
    /// Called from the host. Arg is a plain string: "default" or "focused".
    /// Anything unrecognized falls back to default (Sims overview) so a typo
    /// can't strand the camera in some unintended position.
    /// </summary>
    public void SetCameraMode(string mode)
    {
        if (cameraController == null)
        {
            Debug.LogWarning("[Bridge] SetCameraMode called but no CameraController is wired.");
            return;
        }

        var camMode = mode == "focused"
            ? CameraController.CameraMode.Focused
            : CameraController.CameraMode.Default;
        cameraController.SetMode(camMode);
        Debug.Log($"[Bridge] cameraMode={camMode}");
    }

    /// <summary>
    /// Called from the host. Arg is a JSON string of UIOverlayController.UiStateMessage
    /// shape: {"model":"claude-sonnet-4-5","thinking":"on"}. Pushes authoritative
    /// UI state (selected model highlight, thinking toggle) into the overlay
    /// without echoing events back to JS.
    /// </summary>
    public void SetUiState(string json)
    {
        if (overlayController == null)
        {
            Debug.LogWarning("[Bridge] SetUiState called but no UIOverlayController is wired.");
            return;
        }

        UIOverlayController.UiStateMessage msg;
        try
        {
            msg = JsonUtility.FromJson<UIOverlayController.UiStateMessage>(json);
        }
        catch (Exception e)
        {
            Debug.LogError($"[Bridge] SetUiState invalid JSON: {e.Message} raw={json}");
            return;
        }

        overlayController.ApplyUiState(msg);
        Debug.Log($"[Bridge] uiState model={msg?.model} thinking={msg?.thinking}");
    }

    static AgentState ParseState(string s)
    {
        switch (s)
        {
            case "idle": return AgentState.Idle;
            case "thinking": return AgentState.Thinking;
            case "searching": return AgentState.Searching;
            case "reading": return AgentState.Reading;
            case "answering": return AgentState.Answering;
            case "done": return AgentState.Done;
            case "error": return AgentState.Error;
            default: return AgentState.Unknown;
        }
    }

    static Color ColorForState(AgentState s)
    {
        switch (s)
        {
            case AgentState.Idle: return new Color(0.55f, 0.55f, 0.6f);
            case AgentState.Thinking: return new Color(0.30f, 0.60f, 1.00f);
            case AgentState.Searching: return new Color(1.00f, 0.80f, 0.20f);
            case AgentState.Reading: return new Color(0.70f, 0.40f, 1.00f);
            case AgentState.Answering: return new Color(0.20f, 0.90f, 0.40f);
            case AgentState.Done: return new Color(0.40f, 1.00f, 0.40f);
            case AgentState.Error: return new Color(1.00f, 0.30f, 0.30f);
            default: return Color.white;
        }
    }
}
