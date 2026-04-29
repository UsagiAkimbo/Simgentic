using UnityEngine;

/// <summary>
/// Sprint B helper: keeps a world-space UI element (the thought bubble)
/// pointed at the camera every frame. Attach to the bubble's Canvas so
/// the text reads correctly regardless of character or camera rotation.
///
/// Runs in LateUpdate so it overrides any earlier frame work (e.g. an
/// Animator pulling the bone hierarchy around). Uses transform.rotation
/// rather than LookAt so the bubble stays upright and doesn't roll when
/// the camera tilts.
/// </summary>
public class FaceCamera : MonoBehaviour
{
    Camera cam;

    void Start()
    {
        cam = Camera.main;
    }

    void LateUpdate()
    {
        if (cam == null) cam = Camera.main;
        if (cam == null) return;
        transform.rotation = cam.transform.rotation;
    }
}
