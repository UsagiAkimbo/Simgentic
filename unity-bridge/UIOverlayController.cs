using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using UnityEngine;
using UnityEngine.UI;

/// <summary>
/// Sprint E: wires the Cowork-style overlay UI (radial menu + panels) that was
/// authored in the Editor as plain Images, and forwards interactions to the
/// Next.js host as typed UI events.
///
/// Design choice: Buttons are ADDED AT RUNTIME by this script rather than in
/// the Editor. That keeps the scene as pure layout (art/positioning only) and
/// keeps all behavior in code — so the repo's unity-bridge/ folder remains the
/// single source of truth, and re-authoring the scene art never silently
/// drops a handler.
///
/// Setup (one-time, in the Editor):
///   1. Attach this script to the OverlayCanvas GameObject.
///   2. Nothing else. All children are found by name at Awake. Expected
///      hierarchy (names must match the constants below):
///        OverlayCanvas
///          PanelContainer
///            PlusPanel        (File_Icon, Folder_Icon, Connector_Icon,
///                              Picture_Icon, Skill_Icon, Plugin_Icon)
///            ModelPanel       (3_Opus_Icon, 4-5_Haiku_Icon, 4-5_Sonnet_Icon,
///                              4-6_Opus_Icon, 4-7_Opus_Icon, Toggle)
///            EnviromentPanel  (Project_Icon, New_Task_Icon, Dispatch_Icon,
///                              Live_Artifact_Icon, Memory_Icon, Progress_Icon,
///                              Scheduled_Icon, Customize_Icon, Context_Icon)
///          RadialMenu Base    (RadialMenu_Desk, RadialMenu_File,
///                              RadialMenu_Hand, RadialMenu_Brain, RadialMenu_New)
///
/// Radial spokes (always visible, Sims-style HUD):
///   Brain → toggles ModelPanel
///   File  → toggles PlusPanel
///   Desk  → toggles EnviromentPanel
///   New   → emits "conversation.new" (host clears history) + closes panels
///   Hand  → emits "camera.toggle" (host flips default/focused framing)
///
/// Unity → JS: every interaction calls JS_OnUiEvent with
///   { "action": "<verb>", "value": "<optional>" }
/// JS → Unity: the host pushes authoritative state via
///   BridgeReceiver.SetUiState → ApplyUiState({"model": "...", "thinking": "on"})
/// so highlights survive page-driven changes and reloads.
/// </summary>
public class UIOverlayController : MonoBehaviour
{
#if UNITY_WEBGL && !UNITY_EDITOR
    [DllImport("__Internal")]
    private static extern void JS_OnUiEvent(string json);
#endif

    [Serializable]
    public class UiStateMessage
    {
        public string model;
        public string thinking; // "on" | "off"
    }

    [Header("Selection highlight")]
    [Tooltip("Color of the currently selected model icon.")]
    [SerializeField] Color selectedColor = Color.white;
    [Tooltip("Color of non-selected model icons (dimmed).")]
    [SerializeField] Color unselectedColor = new Color(1f, 1f, 1f, 0.45f);

    // ---- Scene object names (must match the hierarchy) -------------------
    const string PanelContainerName = "PanelContainer";
    const string PlusPanelName = "PlusPanel";
    const string ModelPanelName = "ModelPanel";
    const string EnvPanelName = "EnviromentPanel"; // scene spelling
    const string RadialBaseName = "RadialMenu Base";

    // Model icon name → API model id the host sends to /api/agent.
    // EDIT HERE when the model lineup changes; the host validates against
    // its own allowlist (ALLOWED_MODELS in app/api/agent/route.ts) too.
    static readonly Dictionary<string, string> ModelIconToId = new Dictionary<string, string>
    {
        { "3_Opus_Icon",      "claude-3-opus-20240229" },
        { "4-5_Haiku_Icon",   "claude-haiku-4-5" },
        { "4-5_Sonnet_Icon",  "claude-sonnet-4-5" },
        { "4-6_Opus_Icon",    "claude-opus-4-6" },
        { "4-7_Opus_Icon",    "claude-opus-4-7" },
    };

    // PlusPanel icon name → event action.
    static readonly Dictionary<string, string> PlusIconToAction = new Dictionary<string, string>
    {
        { "File_Icon",      "add.file" },
        { "Folder_Icon",    "add.folder" },
        { "Picture_Icon",   "add.image" },
        { "Connector_Icon", "connector.open" },
        { "Skill_Icon",     "skill.open" },
        { "Plugin_Icon",    "plugin.open" },
    };

    // EnviromentPanel icon name → event action (all stubs host-side for now).
    static readonly Dictionary<string, string> EnvIconToAction = new Dictionary<string, string>
    {
        { "Project_Icon",       "env.project" },
        { "New_Task_Icon",      "env.new_task" },
        { "Dispatch_Icon",      "env.dispatch" },
        { "Live_Artifact_Icon", "env.live_artifact" },
        { "Memory_Icon",        "env.memory" },
        { "Progress_Icon",      "env.progress" },
        { "Scheduled_Icon",     "env.scheduled" },
        { "Customize_Icon",     "env.customize" },
        { "Context_Icon",       "env.context" },
    };

    GameObject plusPanel;
    GameObject modelPanel;
    GameObject envPanel;

    readonly Dictionary<string, Image> modelIcons = new Dictionary<string, Image>();
    Toggle thinkingToggle;
    string selectedModelIcon; // icon NAME of the active model (key of ModelIconToId)

    void Awake()
    {
        // A Canvas built purely from Images may be missing its raycaster.
        if (GetComponent<GraphicRaycaster>() == null)
        {
            gameObject.AddComponent<GraphicRaycaster>();
        }

        var container = transform.Find(PanelContainerName);
        var radial = transform.Find(RadialBaseName);
        if (container == null || radial == null)
        {
            Debug.LogError($"[UIOverlay] Missing '{PanelContainerName}' or '{RadialBaseName}' under {name}. UI not wired.");
            return;
        }

        plusPanel = container.Find(PlusPanelName)?.gameObject;
        modelPanel = container.Find(ModelPanelName)?.gameObject;
        envPanel = container.Find(EnvPanelName)?.gameObject;

        WireRadialSpokes(radial);
        WirePanelIcons(plusPanel != null ? plusPanel.transform : null, PlusIconToAction, isModelPanel: false);
        WirePanelIcons(envPanel != null ? envPanel.transform : null, EnvIconToAction, isModelPanel: false);
        WireModelPanel();

        // Panels start closed; only the radial ring is visible.
        CloseAllPanels();
    }

    // ---- Wiring -----------------------------------------------------------

    void WireRadialSpokes(Transform radial)
    {
        AddButton(radial.Find("RadialMenu_Brain"), () => TogglePanel(modelPanel));
        AddButton(radial.Find("RadialMenu_File"), () => TogglePanel(plusPanel));
        AddButton(radial.Find("RadialMenu_Desk"), () => TogglePanel(envPanel));
        AddButton(radial.Find("RadialMenu_New"), () =>
        {
            CloseAllPanels();
            Emit("conversation.new");
        });
        AddButton(radial.Find("RadialMenu_Hand"), () => Emit("camera.toggle"));
    }

    void WirePanelIcons(Transform panel, Dictionary<string, string> nameToAction, bool isModelPanel)
    {
        if (panel == null) return;
        foreach (Transform child in panel)
        {
            if (!nameToAction.TryGetValue(child.name, out var action)) continue;
            var captured = action;
            AddButton(child, () => Emit(captured));
        }
    }

    void WireModelPanel()
    {
        if (modelPanel == null) return;

        foreach (Transform child in modelPanel.transform)
        {
            if (ModelIconToId.TryGetValue(child.name, out var modelId))
            {
                var icon = child.GetComponent<Image>();
                if (icon != null) modelIcons[child.name] = icon;

                var iconName = child.name;
                var capturedId = modelId;
                AddButton(child, () =>
                {
                    SetSelectedModelIcon(iconName);
                    Emit("model.select", capturedId);
                });
            }
            else if (child.GetComponent<Toggle>() != null)
            {
                thinkingToggle = child.GetComponent<Toggle>();
                thinkingToggle.onValueChanged.AddListener(on =>
                    Emit("thinking.toggle", on ? "on" : "off"));
            }
        }

        RefreshModelHighlight();
    }

    /// <summary>Idempotently add a Button to an Image-only GameObject.</summary>
    static void AddButton(Transform t, Action onClick)
    {
        if (t == null) return;
        var go = t.gameObject;

        var image = go.GetComponent<Image>();
        if (image != null) image.raycastTarget = true;

        var button = go.GetComponent<Button>();
        if (button == null) button = go.AddComponent<Button>();
        button.transition = Selectable.Transition.ColorTint;
        button.onClick.AddListener(() => onClick());
    }

    // ---- Panels -----------------------------------------------------------

    void TogglePanel(GameObject panel)
    {
        if (panel == null) return;
        bool opening = !panel.activeSelf;
        CloseAllPanels();
        panel.SetActive(opening);
        Emit("panel.toggle", $"{panel.name}:{(opening ? "open" : "closed")}");
    }

    void CloseAllPanels()
    {
        if (plusPanel != null) plusPanel.SetActive(false);
        if (modelPanel != null) modelPanel.SetActive(false);
        if (envPanel != null) envPanel.SetActive(false);
    }

    // ---- Model selection highlight ----------------------------------------

    void SetSelectedModelIcon(string iconName)
    {
        selectedModelIcon = iconName;
        RefreshModelHighlight();
    }

    void RefreshModelHighlight()
    {
        foreach (var kv in modelIcons)
        {
            kv.Value.color = kv.Key == selectedModelIcon ? selectedColor : unselectedColor;
        }
    }

    // ---- JS → Unity (called via BridgeReceiver.SetUiState) -----------------

    /// <summary>
    /// Apply authoritative UI state pushed from the host without re-emitting
    /// events back (no feedback loop).
    /// </summary>
    public void ApplyUiState(UiStateMessage msg)
    {
        if (msg == null) return;

        if (!string.IsNullOrEmpty(msg.model))
        {
            foreach (var kv in ModelIconToId)
            {
                if (kv.Value == msg.model)
                {
                    SetSelectedModelIcon(kv.Key);
                    break;
                }
            }
        }

        if (!string.IsNullOrEmpty(msg.thinking) && thinkingToggle != null)
        {
            // SetIsOnWithoutNotify: do NOT fire onValueChanged → no echo to JS.
            thinkingToggle.SetIsOnWithoutNotify(msg.thinking == "on");
        }
    }

    // ---- Unity → JS ---------------------------------------------------------

    static void Emit(string action, string value = "")
    {
        // Values are internal constants (no user text), so naive JSON is safe.
        string json = $"{{\"action\":\"{action}\",\"value\":\"{value}\"}}";
#if UNITY_WEBGL && !UNITY_EDITOR
        try { JS_OnUiEvent(json); }
        catch (Exception e) { Debug.LogWarning($"[UIOverlay] JS_OnUiEvent failed: {e.Message}"); }
#else
        Debug.Log($"[UIOverlay] (editor) ui event: {json}");
#endif
    }
}
