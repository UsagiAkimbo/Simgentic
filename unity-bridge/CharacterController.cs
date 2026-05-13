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

    [Header("Idle micro-behavior intervals (seconds)")]
    [Tooltip("Random interval between blinks while in Idle. Keep short.")]
    [SerializeField] float blinkMinInterval = 2.5f;
    [SerializeField] float blinkMaxInterval = 5.5f;
    [Tooltip("Random interval between weight-shifts / glances while in Idle. Keep longer.")]
    [SerializeField] float shiftMinInterval = 8f;
    [SerializeField] float shiftMaxInterval = 18f;

    static readonly int StateHash = Animator.StringToHash("State");
    static readonly int BlinkHash = Animator.StringToHash("Blink");
    static readonly int ShiftHash = Animator.StringToHash("Shift");

    // Mirror of the latest agent state so the Update loop knows whether it
    // should be firing idle behaviors. Defaults to Idle so the character can
    // start blinking immediately on scene load, before the first event arrives.
    BridgeReceiver.AgentState currentState = BridgeReceiver.AgentState.Idle;
    float nextBlinkAt;
    float nextShiftAt;

    void Awake()
    {
        if (bridge == null) bridge = FindObjectOfType<BridgeReceiver>();
        if (animator == null) animator = GetComponent<Animator>();
    }

    void Start()
    {
        // Stagger the initial timers so the first blink and first shift don't
        // fire on the same frame as scene load.
        nextBlinkAt = Time.time + Random.Range(blinkMinInterval, blinkMaxInterval);
        nextShiftAt = Time.time + Random.Range(shiftMinInterval, shiftMaxInterval);
    }

    void OnEnable()
    {
        if (bridge != null) bridge.OnStateChanged += HandleStateChanged;
    }

    void OnDisable()
    {
        if (bridge != null) bridge.OnStateChanged -= HandleStateChanged;
    }

    void Update()
    {
        if (animator == null) return;

        // Only fire idle behaviors while genuinely idle. During Thinking,
        // Searching, Reading, etc. the main animation should own the body.
        if (currentState != BridgeReceiver.AgentState.Idle) return;

        if (Time.time >= nextBlinkAt)
        {
            animator.SetTrigger(BlinkHash);
            nextBlinkAt = Time.time + Random.Range(blinkMinInterval, blinkMaxInterval);
        }
        if (Time.time >= nextShiftAt)
        {
            animator.SetTrigger(ShiftHash);
            nextShiftAt = Time.time + Random.Range(shiftMinInterval, shiftMaxInterval);
        }
    }

    void HandleStateChanged(BridgeReceiver.AgentState state, string detail)
    {
        currentState = state;
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
