## Compact Keys

Output keys are abbreviated to save tokens (metadata.keys carries this same
mapping generated live, so it can never drift from this list). Full list,
short=full: bounds=absoluteBoundingBox parent=parentName idx=siblingIndex
loc=locationRelativeToParent dim=dimensions w=width h=height hor=horizontal
ver=vertical justify=justifyContent align=alignItems pad=padding
overflow=overflowScroll props=componentProperties propRefs=
componentPropertyReferences compId=componentId compSetId=componentSetId
variants=variantProperties propDefs=propertyDefinitions ts=textStyle
tsName=textStyleName fs=fontSize fw=fontWeight ff=fontFamily lh=lineHeight ls=letterSpacing
textAlignH=textAlignHorizontal textAlignV=textAlignVertical radius=
borderRadius sw=strokeWeight sws=strokeWeights dashes=strokeDashes
fillVars=fillVariableIds blend=blendMode bw=boldWeight impl=implementedBy
icon=iconUrl sf=sfSymbols. Compound instance IDs are stripped to the last
segment (the component definition id) — e.g.
"I3096:91050;1907:3788;2150:30288" -> "2150:30288".

## Layout Mapping

layout: mode/gap/pad/sizing map to NSStackView (orientation, spacing,
edgeInsets); sizing hug = size-to-content, fill = stretch. Add w/h
constraints ONLY when sizing is 'fixed' (value in layout dim).
bounds is the rendered size for reference/verification — never
hardcode it as constraints alongside stack layout.

## Native vs Custom Components

native: true -> the stock AppKit control the component name describes

## Icon Assets

`icon` on a node is a downloadable URL serving that icon's **vector PDF**
bytes (present when the fetch used downloadIcons). The URL has no extension and
downloads as application/octet-stream, so name the file, using this same node's `name` field
