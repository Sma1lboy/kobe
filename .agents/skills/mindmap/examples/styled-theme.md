# Styled Mind Map Theme

Use style blocks and stereotypes for reusable visual classes.

## Example

```plantuml
@startmindmap
<style>
mindmapDiagram {
  .goal {
    BackgroundColor #D5F5E3
  }
  .risk {
    BackgroundColor #FADBD8
  }
  .action {
    BackgroundColor #D6EAF8
  }
}
</style>

* Project Plan
** Goals <<goal>>
*** Launch MVP <<action>>
*** Improve Retention <<action>>
** Risks <<risk>>
*** Scope Creep <<risk>>
*** Delay <<risk>>
@endmindmap
```

## Pattern Notes

1. Define reusable classes in `<style>` once, then apply via `<<class>>`.
2. Keeps large maps visually consistent.
3. Prefer semantic class names (`goal`, `risk`, `action`) over color names.
