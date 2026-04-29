# Unity WebGL build output goes here

After building in Unity, copy the entire contents of your Unity build output directory into `public/unity/`. The expected structure after copying:

```
public/unity/
├── Build/
│   ├── sprite-agent.data
│   ├── sprite-agent.framework.js
│   ├── sprite-agent.loader.js
│   └── sprite-agent.wasm
├── StreamingAssets/        (only if you use Streaming Assets in Unity)
└── TemplateData/           (only if Unity's template includes it — optional to keep)
```

The `components/UnityCanvas.tsx` loader expects:

- `buildPath="/unity/Build"`
- `buildName="sprite-agent"`

So whatever you set as **Build Name** in Unity's File → Build Profiles → Player Settings, it must be `sprite-agent` (or update the `buildName` prop to match).

See `/docs/SPRINT_A.md` for the full setup guide.
