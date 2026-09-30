# Dashboard design

Use this guide for dashboard UI work. The dashboard uses layered surfaces, compact controls,
and a consistent type hierarchy across light, dim, and dark themes.

## Surfaces and controls

Use semantic classes from [theme.css](../apps/dashboard/src/styles/theme.css). The nested-card
rules in [globals.css](../apps/dashboard/src/app/globals.css) supply the theme-specific layering.
Keep palette definitions there instead of introducing page-specific colors.

| Element           | Treatment                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| Page              | `bg-background`, using `PageContainer`                                                            |
| Section card      | `rounded-2xl bg-card p-5`, no decorative outline                                                  |
| Nested route card | `rounded-xl bg-card p-4`, no decorative outline                                                   |
| Text input        | Shared `Input` with `variant="filled"`; recessed `bg-background`                                  |
| Form dropdown     | Shared `CustomSelect` with `variant="filled"` and `triggerClassName="bg-muted/60 hover:bg-muted"` |
| Supporting text   | `text-muted-foreground`                                                                           |

Nested `bg-card` surfaces adapt through the shared CSS: light uses a subtle gray fill, while
dim and dark lift the inner surface. Form dropdowns use a lighter surface than text inputs;
the trigger override above is intentional because `filled` alone uses the input background.

Keep visible keyboard focus, error indicators, meaningful selection outlines, and useful dividers.
Borderless cards do not remove those functional indicators. Menus should use the shared dropdown
component's existing positioning, keyboard behavior, and menu surface.

Reuse [Input](../apps/dashboard/src/components/ui/input.tsx),
[CustomSelect](../apps/dashboard/src/components/ui/CustomSelect.tsx), and
[Button](../apps/dashboard/src/components/ui/button.tsx) instead of copying their implementations.

## Layout and density

- Use [PageContainer](../apps/dashboard/src/components/ui/PageContainer.tsx) for its existing
  1600px page limit and responsive padding. Avoid a second page-width cap inside it.
- Project and deployment configuration pages use a 340px action sidebar when there is room,
  then stack on smaller containers. Keep the destination picker and primary action together.
- Base grids on the available container width so expanded navigation does not squeeze fields.
  Routing cards use two columns when their controls fit comfortably and one column otherwise.
- Keep section spacing consistent (`gap-6` between main columns, `space-y-4` for sidebar items).
  Match action sizes within the same flow. The install action is 44px tall; shared buttons retain
  their established sizes (the default `Button` is 40px).
- A destination with one valid choice, such as Openship Cloud on the hosted service, uses a
  compact summary row. Show a picker when the user has a choice.

## Typography and copy

Use the existing Gellix / SF Arabic font stack and semantic text colors. `text-sm` is 14px;
the dashboard overrides `text-xs` to **13px**, with a 20px line height.
Use `text-sm` for field labels, controls, and primary list information; use `text-xs` for hints
and supporting metadata. Match nearby page headings instead of introducing a new size scale.

Use **Domains & routing** for sections covering domains, published ports, and internal access. Use
**Domains** when the section only manages hostnames. Put shared UI copy in the locale dictionaries.
Keep hints concise and explain choices where they help the user decide.

Catalog category filters match the Library's tabs: compact `text-sm` labels with `px-4 py-2`,
`rounded-lg`, and a filled `bg-foreground text-background` selected state. Inactive choices use
muted text and a subtle hover fill, with no decorative border around each option. Preserve
keyboard focus and expose the selected filter with `aria-pressed`.

Use the shared icon library and the [icon guide](client-icons.md). Avoid decorative icons that
repeat an adjacent label or add clutter to a compact row.

## Catalog forms

Use [AppSettingsForm](../apps/dashboard/src/components/app-settings/AppSettingsForm.tsx) for
install and installed-app settings. Templates define fields and optional layout hints; the
dashboard owns styling. Keep grouping and column choices in catalog JSON instead of checking
app ids in React. A future preview should use this same renderer.

The [catalog reference](../apps/web/content/docs/reference/app-catalog.mdx#form-layout) documents
`installLayout`, group `columns`, and field `fullWidth`. Preserve value state, visibility rules,
validation, and draft behavior when changing presentation.

App routing defaults follow endpoint intent, independently of the deployment target. Public web
UIs and APIs start with domain routing; raw database ports start internal unless the catalog
explicitly says otherwise. Honor `defaultMode` and `allowedModes`, and preserve saved choices.
Cloud availability selects free versus custom domains; it does not decide whether a UI is routed.

## Checking a change

Inspect light, dim, and dark themes; narrow and wide containers; and expanded and collapsed
navigation. Check keyboard focus, open dropdowns, long labels, and RTL when the layout changes.
Use focused behavior tests for changes to field selection, validation, or payloads. A copy or
spacing adjustment needs visual verification, not a test that asserts a CSS class string.
