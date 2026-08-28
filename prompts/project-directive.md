## Engine Docs Lookup

For engine/Offline questions query Native_EngineDocsMCP.
For Server/Online questions query the user

## Architecture

AppKit only, never SwiftUI. VIPER for document/module work; MVP ok for small self-contained features.Check
`docs/architecture/*.md` before starting UI work .

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

## Asset & Value Fidelity Workflow

Before writing UI code from a fetch: (1) pull every asset you'll reference and
download it yourself before referencing it. Fastest path for icons: pass
`downloadIcons: true` to `get_figma_data` — every icon in the scoped subtree
comes back with a downloadable PDF link on its `icon` field, and the
response includes a `download_icons.py` content block.
collect every `{name, icon}` pair from
the fetched tree into a JSON array, and run the saved script against it —
it fetches and names each PDF correctly. Do NOT hand-write the download/save
loop yourself, that's exactly where naming and extension mistakes happen.
For a one-off node, `get_render_urls` (pass the node id(s)) returns the
same downloadable URLs. (2) Diff every color/value against what the app already has.

## App Color, Icon & Font Systems

Multiple independent color systems (app-target catalog, a Pod-side
hex-named catalog, OS semantic NSColors), two icon systems (per-module
catalogs, a network-fetched glyph font), and one font system
(`ZSAppearance.TextStyle` — system font only, size/weight vary, never a
custom family) — never assume "the" system from the Figma design alone.
Before adding or changing any of the three, read
`ColorAndIconFlow.md` .
Never map a fetched color to an `NSColor.*` semantic name yourself.

## Component Variants

Implement every variant a component supports, not just the one visible
here. Every remote component set's variant data lives in a SECOND YAML
document

## Unnamed Assets

`unnamedAssets` (when present) lists colors/icons/fonts with no
design-system name. Never hardcode these. Read `ColorAndIconFlow.md` first
-> the same placement rules apply to a temporary asset as a real one. ASK
THE USER, then place in a `temp` folder -> do not create or write anything
before they confirm. Once approved: a colorset stub per color; icons via
`get_render_urls` + `download_icons.py`; a note per font naming the
`ZSAppearance` typeface it maps to.

## Custom Component Reuse Check

Before creating a new custom Swift view/component, ask the user whether an
equivalent already exists elsewhere in the app. If a Dev
Resources link (or the user) points at a specific existing class to reuse
and reusing it turns out costlier than expected don't unilaterally decide it's not worth reusing and write a new
one instead. Surface the real friction found and ask the
user before choosing not to reuse it or better suggest either to restructure
and globally use that class.

If there's no Dev Resources link at all, that absence is not confirmation
it's genuinely new — ask the user before starting it as a new component.
