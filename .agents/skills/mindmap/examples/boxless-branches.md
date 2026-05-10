# Boxless Branches Mind Map

Use boxless node variants to reduce visual weight for secondary branches.

## Example

```plantuml
@startmindmap
<style>
mindmapDiagram {
  node {
    BackgroundColor #E8F5E9
  }
  boxless {
    FontColor #2E7D32
  }
}
</style>

+ Product Roadmap
++ Core Capabilities
+++ API Platform
+++_ Internal Integrations
+++_ Operational Notes
++ User Experience
+++ Onboarding
+++_ Copy Tweaks
+++_ Accessibility Checks
-- Risks
--- Delivery Delay
---_ Vendor Dependency
--_ Parking Lot
@endmindmap
```

## Pattern Notes

1. Add `_` after branch marker (for example `+++_`) to render a boxless node.
2. Boxless nodes are useful for optional details and annotations.
3. `boxless { ... }` in `<style>` lets you globally tune typography for boxless nodes.
4. You can mix boxed and boxless nodes in the same branch hierarchy.
