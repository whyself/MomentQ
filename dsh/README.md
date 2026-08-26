# MomentQ DSH Runtime

This directory owns the DSH execution layer for MomentQ.

- `packages/bundle/` is the installable MomentQ Bundle and Preset.
- `packages/runtime/` will pin and launch the native DSH framework for local users.
- `docker/` will contain the reproducible container image and entrypoint.

Application components are separate repository-level products: `../extension/`, `../shared/`, and `../companion/`. The runtime must preserve one logical data root:

```text
<MOMENTQ_DATA_ROOT>/
├─ content/
└─ dsh-home/
```

The native launcher and Docker image are specified in Task 10 of the implementation plan; this directory currently contains the Bundle only.
