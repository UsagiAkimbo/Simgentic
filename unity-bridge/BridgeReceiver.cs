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
    }

    void Start()
    {
#if UNITY_WEBGL && !UNITY_EDITOR
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
