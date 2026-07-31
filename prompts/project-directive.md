_Behavior directive for Claude consuming this MCP (native macOS/Swift/AppKit
app). One rule per `## ` heading -> enrich-design.ts's parseMarkdownRules
flattens each to "Heading: body" (whitespace collapsed) into design.guide +
MCP instructions. Everything above the first `## ` heading is never sent
(the parser drops it) — edit this note freely.
Rebuild + kill stale dist/bin.js processes for changes to take effect._

## Identity

Use this MCP's tools (get_figma_data, download_figma_images, write_imageset,
write_colorset) as source of truth for any Figma-related task on this native
macOS Swift/AppKit app. Never guess a color/spacing/icon; never browse Figma
instead of calling a tool.

## Engine Docs Lookup

For engine/API questions (not Figma design data) — does a function exist,
what it's called, what it takes — query Native_EngineDocsMCP first. Treat
results as offline reference that can lag live behavior — verify with the
user before relying on it, don't treat a match as final proof. Genuinely
live/online behavior -> ask the user directly rather than guessing.

## Architecture

AppKit only, never SwiftUI. VIPER for document/module work; MVP ok for
small self-contained features — match the existing pattern in that area, or
pick one and say why if ambiguous. View = UI only, not even trivial logic —
every decision (state, conditionals, transforms, business rules) belongs in
the Presenter/Interactor/Controller; an `if` in a View that isn't about
layout/appearance belongs one layer up, move it. Check
`docs/architecture/*.md` before starting UI work — most code flow (VIPER
stack wiring, module/controller relationships, build-mode conditionals) is
already documented there; still unclear -> ask the user rather than guess.
Read only what's needed there, don't over-fetch docs.

## Auto Layout — Anchors

Real NSLayoutConstraint anchors always — never fixed frames or x/y origins.
In setupViews()/setUpViews() (called from loadView/viewDidLoad): create
views -> addSubview -> translatesAutoresizingMaskIntoConstraints = false ->
activate. Either inline `.isActive = true` per line, or collect into
`[NSLayoutConstraint]()` + `.activate()` once — match whichever the file
already uses. Semantic anchors only (leading/trailing/top/bottom — never
left/right). Leading/top constants positive; trailing/bottom negative. Store
as a `var: NSLayoutConstraint` property only if toggled/swapped at runtime.
User-facing strings always via `ZSLocalization.localizedStringFor(key:)`.

## Auto Layout — Sizing

FILL axis -> pin both opposing edges (stretches). HUG -> don't pin the far
edge; give the tight sibling `.required`/`.defaultHigh` content-hugging and
`.defaultLow` to the slack-absorbing sibling, plus compression-resistance
(`.required` on must-show icons/controls, `.defaultLow` on truncatable
labels) — symbolic priorities only, never raw `Priority(rawValue:)`. FIXED ->
`widthAnchor`/`heightAnchor` constant. Static frame with no auto-layout
intent -> infer anchors from geometry (shared edges -> shared anchor,
consistent margin -> pin that edge, equal gaps -> one spacing constant);
state briefly what you inferred.

## Auto Layout — Conventions

Defaults — defer to the fetched value when it differs: edge margin 20
(leading +20 / trailing -20 / bottom -20; dialog top ~+15); gap 8 between
adjacent elements, 12 between stacked rows; control height ~20; button
min-width 65 via `greaterThanOrEqualToConstant`; primary/default button also
gets `bezelColor = .controlAccentColor` + `keyEquivalent = "\r"`. No
spacing-token system — inline numeric literals (some dialogs use a local
`let margin: CGFloat = 20`). NSStackView only for homogeneous control groups
(radio/checkbox/rating) — still pin the stack's own edges with manual
anchors. Manual anchors for everything else.

## Asset & Value Fidelity Workflow

Before writing UI code from a fetch: (1) `downloadIcons: true` is a per-fetch
call, not a standing default — only when this fetch needs new/changed icons;
`download_figma_images` covers non-icon raster fills. Never reference an
asset without pulling it down first. (2) Diff every color/value against what
the app already has. (3) Match Figma exactly — no rounding, no "close
enough" substitution. (4) Deviate only for a genuine conflict (asset can't
be produced cleanly, shared color, ambiguous node) — never silently. (5)
Always disclose any changed/overridden value: what, from -> to, and why.

## App Color & Icon Systems

This app has multiple independent color systems (an app-target asset
catalog, a separate Pod-side hex-named catalog, plain OS-level semantic
NSColors) and two independent icon systems (per-module static asset
catalogs, a network-fetched icon glyph font) — never assume "the"
color/icon system from the Figma design alone. Before adding or changing a
color/icon in code, read `docs/ColorAndIconFlow.md` for which system/catalog
to target and known gotchas (dark-mode variant gaps, crash-vs-silent-fallback
access patterns, the icon font's unverified consumption path). Never map a
fetched color to an `NSColor.*` semantic name yourself, even if its value
looks like a standard OS color — per LIGHT THEME ONLY the fixed Light value
is what gets built, and a semantic NSColor would track system appearance
instead, which is wrong here regardless of how "system-like" the color
looks. For whether/how an OS-level color genuinely applies, read the docs
above rather than guessing.

## Large Fetches

Don't implement an oversized tree in one shot — re-fetch broken up by child
nodeId (one section/screen/component at a time). Implement + verify each
fully (compiles, matches fetched values, no regressions) before the next;
wire sub-modules together last.

## Icon vs Image

Use the Icon child (cropped tight, small, VECTOR/IMAGE-SVG — what's actually
placed in the UI), never the Image child (larger uncropped source), even
though Image is often easier to spot. Sanity-check `absoluteBoundingBox`
against the on-screen slot size before `write_imageset`; a mismatch means
the wrong node.

## Icons — Figma Is The Only Source

Every icon = the downloaded vector PDF (`iconFile`, via `write_imageset`) or
the exact `{sf:name}` SF Symbol the design encodes — never a similar-looking
system icon, a guessed SF Symbol name, or anything outside this fetch. If
unresolvable (download failed, ambiguous node, no `{sf:name}`), stop and
tell the user exactly which icon and why — never a placeholder.

## Component Variant Reference

Implement every variant a component supports, not just the one visible
here. `componentVariantReferences` (end of response, when present) is
fetched and attached automatically — a Dev Resources link on this component
pointed at a reference canvas, pulled in this same call, no second fetch
needed. Each entry has `componentSets[id].propertyDefinitions.variantOptions`
(every combination possible) and `nodes` (combinations actually on the
reference canvas, core details only). `nodes` covers every combination in
`propertyDefinitions` -> implement all of them. It doesn't (canvas shows 4
of 6 states) -> implement what's there, tell the user which combinations
have no visual reference yet rather than inventing them. Absent entirely ->
no link exists yet -> implement only the visible variant and flag the gap.

## Confirm Before New UI Flows

A new dialog/sheet/window/screen/app-state that isn't already a reachable
flow in the app -> ask the user before building it. Don't assume it's wanted
just because the design implies one.

## Dropdown / Pop-Up Values

The fetched label is only the one option selected in this instance, not the
full value set — Figma can't encode a control's complete option list. Other
than the label/placeholder (the only static parts), options come from the
engine at runtime, not hardcoded UI content. Existing flow elsewhere
already wires the same/equivalent engine-backed dropdown -> follow that
connection. Genuinely new -> look it up via Native_EngineDocsMCP (see Engine
Docs Lookup) and confirm with the user before wiring up. Never hardcode
options by guessing from the one visible label.

## Custom Component Reuse Check

Before creating a new custom Swift view/component, ask the user whether an
equivalent already exists elsewhere in the app. Missing `implementedBy`/
`native` on a node means only THIS instance has no recorded implementation —
not that no reusable class exists anywhere in the codebase. If a Dev
Resources link (or the user) points at a specific existing class to reuse
and reusing it turns out costlier than expected (a protocol to conform to,
coupling to something unrelated, more integration work than a fresh
one-off) — don't unilaterally decide it's not worth reusing and write a new
one instead. Surface the real friction found and ask the
user before choosing not to reuse it or better suggest either to restructure
and globally use that class.

## Reverify Fetched Values Before Finishing

fontSize/fontWeight/lineHeight/letterSpacing/color/alpha/padding/gap/sizing/
constraints come only from the fetch — never round, normalize, or revert
(13 stays 13, weight 510 stays 510, not "500"). Don't touch values outside
a requested change — silently reverting a correct fetched value is a
regression. Before finishing, re-check every touched node's text style AND
layout/constraints against the fetch, exact match not approximate; flag a
suspected design mistake to the user rather than silently "fixing" it.
