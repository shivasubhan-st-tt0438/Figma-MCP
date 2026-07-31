_Consumption guide: how to READ this MCP's output format (not how to behave —
that's project-directive.md). Sent to the AI verbatim, one rule per `## `
heading, alongside every design.guide fetch and the MCP session's
`instructions` (see enrich-design.ts's parseMarkdownRules). Everything above
the first `## ` heading is never sent (the parser drops it) — edit this note
freely._

_Heading order matters: addConsumptionGuide splices a dynamically-generated
token-indirection rule in right after the 2nd heading (index 2), so
"Layout Mapping" and "Layout Constraints" must stay the first two._

_Each heading becomes "HEADING: body text" with the body's internal
whitespace/newlines collapsed to single spaces — write body paragraphs
wrapped however is readable here, it renders as one line downstream._

## Compact Keys

Output keys are abbreviated to save tokens (metadata.keys carries this same
mapping generated live, so it can never drift from this list). Full list,
short=full: bounds=absoluteBoundingBox parent=parentName idx=siblingIndex
loc=locationRelativeToParent dim=dimensions w=width h=height hor=horizontal
ver=vertical justify=justifyContent align=alignItems pad=padding
overflow=overflowScroll props=componentProperties propRefs=
componentPropertyReferences compId=componentId compSetId=componentSetId
variants=variantProperties propDefs=propertyDefinitions ts=textStyle
fs=fontSize fw=fontWeight ff=fontFamily lh=lineHeight ls=letterSpacing
textAlignH=textAlignHorizontal textAlignV=textAlignVertical radius=
borderRadius sw=strokeWeight sws=strokeWeights dashes=strokeDashes
fillVars=fillVariableIds blend=blendMode bw=boldWeight impl=implementedBy
icon=iconFile sf=sfSymbols. Compound instance IDs are stripped to the last
segment (the component definition id) — e.g.
"I3096:91050;1907:3788;2150:30288" -> "2150:30288".

## Layout Mapping

layout: mode/gap/pad/sizing map to NSStackView (orientation, spacing,
edgeInsets); sizing hug = size-to-content, fill = stretch. Add w/h
constraints ONLY when sizing is 'fixed' (value in layout dim).
bounds is the rendered size for reference/verification — never
hardcode it as constraints alongside stack layout.

## Layout Constraints

layout.constraints = Figma's resize-pinning -> real NSLayoutConstraint
anchors, never a fixed x/y frame. hor: LEFT->leadingAnchor,
RIGHT->trailingAnchor, LEFT_RIGHT->pin both (flexes with parent),
CENTER->centerXAnchor, SCALE->proportional width. ver: TOP->topAnchor,
BOTTOM->bottomAnchor, TOP_BOTTOM->pin both (flexes), CENTER->centerYAnchor,
SCALE->proportional height. Leading/top pin distance =
loc (x/y); trailing/bottom = parent size minus
(position + size), from the parent's bounds. Has constraints ->
NOT in an auto-layout flow -> use anchors, not NSStackView. No constraints
but parent's layout.mode is row/column -> IS in the flow -> use NSStackView
instead. Never mix both for the same node.

## Native vs Custom Components

native: true -> the stock AppKit control the component name describes
('Pop-Up Button' -> NSPopUpButton). Children are Figma's visual
decomposition of that control (drawn cursors, chevrons, placeholder layers)
— mine them for strings/icons/state, never rebuild as views; a native
node's children already got pruned out of this fetch when nothing in them
was mineable. No `native` -> this app's own custom component -> map to its
Swift class, not stock AppKit. `impl` overrides `native` — the
design team already has a real implementation for this exact instance, use
it instead of the stock control even though native: true is also set.
Resolve `symbol` via `scopePath` when present (underscore-separated,
outermost to innermost: ClassName alone = the type itself;
ClassName_variableName = a property inside it;
ClassName_functionName_variableName = a variable inside a method;
functionName_variableName = a variable inside a free function, no class) —
locate the outermost element first, search inside it for the next, and so
on; the last element is the exact declaration. No scopePath means `symbol`
names the whole type or a single top-level declaration directly.

## SF Symbols

{sf:name} inside text is an SF Symbol — set it via
NSImage(systemSymbolName:) on the control (names also listed under the
node's sf); it is not literal string content.

## Box Shadow

boxShadow may list multiple comma-separated shadow layers; NSView supports a
single NSShadow — match the dominant (largest-blur) layer unless a
pixel-exact focus ring justifies custom layer drawing.
