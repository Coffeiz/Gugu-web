# Frontend Design Guidelines

This document defines the visual implementation rules for the Gugu frontend. When a design mock, page stylesheet, and shared component disagree, follow token layering, style ownership, and accessibility rules first. Do not hide a conflict by adding another temporary CSS layer.

## Goals

- Keep the same information hierarchy across Aero / Mono, Light / Dark, and Mist / Cafe / Rose / Sky / Sage.
- Make color, spacing, radius, elevation, typography, and motion named, reusable, inspectable, and testable.
- Give shared components stable DOM, state, and style boundaries. Pages should compose components instead of rewriting internals.
- Keep /design a running token and component catalog, not a disconnected static mockup.

## Style Entry Points and Ownership

Global styles enter only through:

text
frontend/src/assets/styles/global.css
└── variables.css
    ├── tokens/index.css
    │   ├── foundation/index.css
    │   ├── themes/index.css
    │   ├── palettes/index.css
    │   ├── semantic/index.css
    │   └── components/index.css
    ├── theme-refinements.css
    ├── design-overrides.css
    ├── components/index.css
    ├── design-theme-fixes.css
    ├── bridges/index.css
    └── adoption/index.css

The responsibilities are defined in frontend/src/assets/styles/STYLE-OWNERS.md:

- tokens defines variables, not business-node DOM state.
- theme-refinements.css maps themes to semantic roles; it does not own business component paint.
- components/index.css and its child files own component backgrounds, borders, shadows, hover states, and structural paint.
- bridges handles Teleport, floating roots, and cross-DOM boundaries only.
- adoption and legacy refinement files are migration compatibility layers. The same property must have one final owner.
- Runtime-managed transform, transition, and opacity must not be overridden by theme CSS, !important, or duplicate selectors.

Check the owner before changing styles. If a state is defined in scoped CSS, global CSS, component CSS, and page CSS, remove the duplicate owner before changing the final rule.

## Token Layers

Tokens flow in one direction:

foundation -> theme/palette -> semantic role -> component contract

Lower layers must not depend on higher layers. Business components must not depend directly on an atomic color from one theme file.

| Layer | Files | Responsibility | Examples |
|---|---|---|---|
| Foundation | tokens/primitives.css, tokens/motion.css | Theme-neutral size, type, radius, elevation, z-index, and duration scales | --space-md, --font-size-sm, --radius-md |
| Theme | tokens/themes/*.css | Aero/Mono material and light/dark surface composition | glass-light.css, mono-dark.css |
| Palette | tokens/palettes/*.css | Palette color bases and accents | --project-sky |
| Semantic | tokens/semantic.css, tokens/semantic/index.css | Product roles and information hierarchy | --surface-page, --content-primary |
| Component | tokens/components.css, tokens/components/*.css | Reusable component contracts and state groups | --control-*, --input-* |
| Product | tokens/canvas.css, tokens/product.css | Stable visual interfaces for canvas, notes, and projects | --canvas-dot-color, --note-paper-* |

### Naming and Consumption

- Foundation scales use --space-*, --font-size-*, --radius-*, --font-family-*, --elevation-*, and --motion-*.
- Semantic surfaces use --surface-*, text uses --content-*, edges use --border-*, actions use --action-*, and state uses --status-*.
- Component contracts use prefixes such as --control-*, --input-*, --choice-chip-*, --modal-card-*, --danger-button-*, --project-card-*, and --gugu-*.
- Define rest, hover, active/selected, focus-visible, disabled, and danger states together where applicable.
- Keep one public token for one meaning. Do not create parallel aliases such as --text-main, --text-primary, and --content-primary.
- Name roles, not one page implementation. --surface-raised is preferable to --projects-white-card.
- Components should consume semantic translucent surfaces instead of scattering rgba values.

Recommended chain:

css
.app-card {
  background: var(--card-surface-bg);
  border: 1px solid var(--card-border);
  box-shadow: var(--card-shadow);
}

Hover changes the component surface itself. Do not place an overlay over text or icons. Keep one primary transition per property and use the standard motion tokens. For transform, opacity, or visibility during Runtime or landing, establish visual ownership before writing CSS.

### Adding or Changing a Token

1. Check whether an existing token already expresses the meaning.
2. Choose the lowest correct layer: foundation for scales, theme for material, palette for color bases, semantic for product roles, and component for component states.
3. Check Aero/Mono, Light/Dark, and every supported palette.
4. Define the complete state group and consume it from the owning component. Remove old aliases and duplicate rules.
5. Register the name, variable, category, type, and usage in frontend/src/views/Design/data/tokenCatalog.ts. The catalog stores metadata only, not copied CSS values.
6. Add a real sample or index entry to /design and verify it uses the actual token.
7. Add or update component/CSS tests and run typecheck, affected tests, and build checks.

## The /design Page

/design is an authenticated route. Its entry is frontend/src/views/Design/index.vue and its main view is DesignSystemPage.vue. It is a runtime viewer and interactive sample page.

It currently provides:

- Theme switching for Aero/Mono, Light/Dark/System, and five palettes.
- Foundation samples for colors, type, font families, spacing, radius, scrollbar, and motion.
- Semantic samples for Surface, Content, Border, Action, and Status.
- Component contracts for sidebar, topbar, project cards, GuguChat, destructive actions, ConfirmDialog, inputs, secondary actions, choice chips, notes, and elevation.
- Product samples with hover/active states, modal previews, real scroll containers, and canvas/note palettes.
- useDesignTokens() provides the base capability to read computed values from getComputedStyle(document.documentElement) and copy variable/value. The current page primarily demonstrates real var(...) usage; copy controls are not currently wired into the page.

The page does not directly add or persist CSS tokens. tokenCatalog.ts and page sample arrays are registration/display data, not a runtime configuration store. Do not write new tokens to localStorage, user preferences, or the backend as a substitute for a reviewed code change.

The supported path is:

token CSS -> catalog metadata -> /design sample -> tests

If an editor is added in the future, it must produce a reviewed code change or design proposal. A production page must not mutate global CSS directly.

## Shared Component Selection

The complete directory and extraction rules are in frontend/src/components/common/README.md.

| Category | Components | Use |
|---|---|---|
| Auth | AuthBrand, AuthLanguageSwitcher, AuthPageFooter | Login and registration branding, language, and footer |
| Controls | ActionButton, Checkbox, ToggleSwitch, SegmentedControl, SearchInput | Commands, binary options, switches, modes, and search |
| Date/filter | DatePicker, DateSpanPicker, TimeInput, SortMenu, RefreshButton | Calendar, time, sorting, and refresh |
| Layout | Brand, AppSidebar, NavItem, GlobalSearch, GlassBg, FloatPreviewWindow | Product frame, navigation, search, and floating backgrounds |
| Overlays | BaseModal, ConfirmDialog, CloseButton, PopupMenu, ContextMenu, UploadConflictDialog | Modals, destructive confirmation, menus, and upload conflicts |
| Feedback | AppToast, FeedbackModal, NotificationBubble, SupportModal, KoFiIcon | Status feedback, notifications, feedback, and support |
| Content | MarkdownView, ReferenceSuggestMenu | Sanitized Markdown and reference suggestions |
| Files/viewers | FileBrowserPanel, file/folder cards, ImageViewer, PdfViewer, TextViewer, VideoViewer | File library and media preview |
| Chat | GuguChat, composer, message list, sidebar, tool bubble, mini player | Chat window, messages, tools, and input |
| Profile | AvatarCropper, MessageFormatSettings, profile panes | Profile, preferences, formats, and workspace |
| Mind | CardAffordances | Shared Mind affordances; drag and landing ownership remains with Runtime |
| Icons | Icon, iconRegistry, iconTypes | Registered and type-safe icons |

Page-specific event forms, Admin controls, and one-page business cards stay under views/<Page>/components/.

### Control State Contract

- Use ActionButton for explicit commands. Icon-only buttons require title or an accessible label.
- Use Checkbox for multi-select or explanatory binary options; use ToggleSwitch for immediate settings.
- Use SegmentedControl for mutually exclusive modes such as language, theme, or sort mode.
- Every control needs rest, hover, focus-visible, active/checked, disabled, and validation/error states where relevant.
- Destructive actions must use useConfirmDialog/ConfirmDialog. Native alert, confirm, and prompt are prohibited.
- Untrusted Markdown/HTML must use the shared sanitization path. Shared components must not render unsanitized v-html.
- Components must clean up listeners, timers, observers, portals, and asynchronous work on unmount.

## Theme, Layout, and Motion

- Resolve light/dark and palette differences through tokens, not page-specific theme branches.
- Keep cards, buttons, inputs, and overlays dimensionally stable. Text must fit in Chinese, English, Japanese, and narrow layouts.
- Use unframed page sections; reserve cards for repeated items, modals, and genuinely framed tools.
- Use glass only for a meaningful panel or floating layer, with readable contrast in dark mode.
- Hover, focus, and pressed states must transition with one owner. Do not stack overlays, pseudo-elements, and component state for one effect.
- Canvas nodes, drag proxies, and landing nodes must follow Runtime ownership of transform, opacity, and visibility.
- Respect prefers-reduced-motion without removing necessary state or drag feedback.

## Verification Checklist

- Check light/dark, Aero/Mono, and at least two palettes for surface, text, border, and hover contrast.
- Check Tab, Enter/Space, Escape, and focus-visible behavior.
- Check Chinese, English, Japanese, long titles, empty/error states, and narrow layouts.
- Check that hover background, border, shadow, text, and icon transitions are synchronized, with no duplicate CSS or flashes.
- After token changes, run frontend typecheck, affected Vitest/CSS tests, and build checks; perform browser validation for real interactions.
