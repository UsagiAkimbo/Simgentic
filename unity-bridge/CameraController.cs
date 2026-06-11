using UnityEngine;

/// <summary>
/// Sprint D Phase 6: dual-camera controller for the Simgentic stage.
///
/// Holds two preset views — a "default" Sims-like top-down/isometric overview,
/// and a "focused" face-on conversation framing — and smoothly lerps between
/// them on demand. The transition target is whatever was last requested via
/// SetMode; Update() animates the camera toward it every frame.
///
/// Setup:
///   1. Drop this script onto the scene's Main Camera GameObject.
///   2. (Optional) Tweak the four position/rotation/FOV fields in the
///      Inspector to taste — the defaults are a reasonable starting point but
///      every scene's character height / room size is a little different.
///   3. Wire this CameraController into BridgeReceiver's Inspector slot
///      named "Camera Controller". BridgeReceiver.SetCameraMode forwards
///      string events from JS into SetMode here.
///
/// Triggering from the Next.js side:
///   unity.sendMessage("BridgeReceiver", "SetCameraMode", "focused");
///   unity.sendMessage("BridgeReceiver", "SetCameraMode", "default");
///
/// At scene load the camera snaps instantly to the default view (no lerp
/// from whatever transform Unity left the camera at on Awake).
/// </summary>
[RequireComponent(typeof(Camera))]
public class CameraController : MonoBehaviour
{
    public enum CameraMode { Default, Focused }

    [Header("Default view — classic Sims top-down/isometric overview")]
    [Tooltip("Where the camera sits when no agent is selected. Higher and pulled back so the character + room are both readable.")]
    [SerializeField] Vector3 defaultPosition = new Vector3(3.5f, 3.5f, -3.5f);
    [SerializeField] Vector3 defaultEulerRotation = new Vector3(35f, -35f, 0f);
    [Tooltip("FOV of 30-35 gives a flatter, more isometric look than the focused view's 35-40.")]
    [SerializeField] float defaultFov = 32f;

    [Header("Focused view — face-on conversation framing")]
    [Tooltip("Where the camera sits when an agent is selected for conversation. Closer, head-and-torso framing.")]
    [SerializeField] Vector3 focusedPosition = new Vector3(0f, 1.5f, -3f);
    [SerializeField] Vector3 focusedEulerRotation = new Vector3(10f, 0f, 0f);
    [SerializeField] float focusedFov = 35f;

    [Header("Transition")]
    [Tooltip("How fast the camera lerps to a new target. 3-5 feels snappy; 1-2 is more cinematic. 0 disables transitions.")]
    [SerializeField] float lerpSpeed = 3.5f;

    Camera cam;
    Vector3 targetPosition;
    Quaternion targetRotation;
    float targetFov;
    CameraMode currentMode = CameraMode.Default;

    void Awake()
    {
        cam = GetComponent<Camera>();
        // Snap to default view at scene load — no animation from whatever the
        // editor-time camera transform happened to be.
        SetMode(CameraMode.Default, instant: true);
    }

    void Update()
    {
        if (lerpSpeed <= 0f)
        {
            // Instant mode for testing — useful when tuning preset values.
            transform.position = targetPosition;
            transform.rotation = targetRotation;
            if (cam != null) cam.fieldOfView = targetFov;
            return;
        }

        float t = Time.deltaTime * lerpSpeed;
        transform.position = Vector3.Lerp(transform.position, targetPosition, t);
        transform.rotation = Quaternion.Slerp(transform.rotation, targetRotation, t);
        if (cam != null)
        {
            cam.fieldOfView = Mathf.Lerp(cam.fieldOfView, targetFov, t);
        }
    }

    /// <summary>
    /// Set the active camera mode. Pass instant=true to snap to the new
    /// view immediately (no lerp) — used at scene load.
    /// </summary>
    public void SetMode(CameraMode mode, bool instant = false)
    {
        currentMode = mode;
        switch (mode)
        {
            case CameraMode.Focused:
                targetPosition = focusedPosition;
                targetRotation = Quaternion.Euler(focusedEulerRotation);
                targetFov = focusedFov;
                break;
            case CameraMode.Default:
            default:
                targetPosition = defaultPosition;
                targetRotation = Quaternion.Euler(defaultEulerRotation);
                targetFov = defaultFov;
                break;
        }

        if (instant)
        {
            transform.position = targetPosition;
            transform.rotation = targetRotation;
            if (cam != null) cam.fieldOfView = targetFov;
        }
    }

    /// <summary>Read-only accessor so other scripts can branch on current mode.</summary>
    public CameraMode CurrentMode => currentMode;
}
