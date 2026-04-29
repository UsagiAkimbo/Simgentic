using TMPro;
using UnityEngine;

/// <summary>
/// Sprint B: drives the in-scene character + thought bubble in response to
/// agent state events from the Sprint A bridge. Subscribes to
/// BridgeReceiver.OnStateChanged and translates each event into:
///   - an Animator integer parameter "State" (drives the Animator Controller)
///   - the active/inactive flag on the ThoughtBubble GameObject
///   - the text content of the TMP_Text inside the bubble
///
/// Setup:
///   1. Place this script on your character GameObject (the one with the
///      Animator component).
///   2. In the Inspector, drag in the Animator, the ThoughtBubble Canvas
///      GameObject, and its TMP_Text. The Bridge field is optional — at
///      Awake the script will FindObjectOfType<BridgeReceiver>() if empty.
///   3. Make sure your Animator Controller has an Int parameter named
///      "State" and Any-State transitions keyed off equality with the
///      AgentState enum values (Idle=0, Thinking=1, ...).
///
/// The default messages below are shown when an event arrives without a
/// detail string (e.g. when triggered by the Sprint A test panel buttons).
/// Real agent traffic from /api/agent will usually carry a meaningful
/// detail (a search query, a doc title, etc.) which takes precedence.
/// </summary>
public class CharacterController : MonoBehaviour
{
    [SerializeField] BridgeReceiver bridge;
    [SerializeField] Animator animator;
    [SerializeField] GameObject thoughtBubble;
    [SerializeField] TMP_Text bubbleText;

    static readonly int StateHash = Animator.StringToHash("State");

    void Awake()
    {
        if (bridge == null) bridge = FindObjectOfType<BridgeReceiver>();
        if (animator == null) animator = GetComponent<Animator>();
    }

    void OnEnable()
    {
        if (bridge != null) bridge.OnStateChanged += HandleStateChanged;
    }

    void OnDisable()
    {
        if (bridge != null) bridge.OnStateChanged -= HandleStateChanged;
    }

    void HandleStateChanged(BridgeReceiver.AgentState state, string detail)
    {
        if (animator != null) animator.SetInteger(StateHash, (int)state);

        if (thoughtBubble != null)
        {
            // Keep the bubble hidden during quiet states (idle, done) unless
            // the agent passed an explicit message — gives the room a calmer
            // resting feel between active sequences.
            bool isQuiet = state == BridgeReceiver.AgentState.Idle ||
                           state == BridgeReceiver.AgentState.Done;
            bool show = !isQuiet || !string.IsNullOrEmpty(detail);
            thoughtBubble.SetActive(show);

            if (bubbleText != null)
            {
                bubbleText.text = !string.IsNullOrEmpty(detail)
                    ? detail
                    : DefaultMessageFor(state);
            }
        }
    }

    static string DefaultMessageFor(BridgeReceiver.AgentState s)
    {
        switch (s)
        {
            case BridgeReceiver.AgentState.Thinking: return "Thinking…";
            case BridgeReceiver.AgentState.Searching: return "Searching the web…";
            case BridgeReceiver.AgentState.Reading: return "Reading results…";
            case BridgeReceiver.AgentState.Answering: return "Writing the answer…";
            case BridgeReceiver.AgentState.Done: return "Done!";
            case BridgeReceiver.AgentState.Error: return "Hit a snag.";
            default: return "";
        }
    }
}
