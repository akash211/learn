# Layout, Themes, and Component Libraries

A Dash layout is a tree of components whose properties express both structure and initial state. The tree can be written directly in Python, composed from reusable functions, or generated from data. Treat layout as a user interface, not as a place to put business rules: clear hierarchy, semantic grouping, responsive sizing, and consistent design are what make a dashboard usable when the number of controls and pages grows.

## Compose small components

Dash's `html` module mirrors familiar HTML elements, while `dcc` provides interactive components. Third-party libraries add their own component namespaces. A layout is typically nested `html.Div` containers, headings, forms, graphs, tables, and navigation. Extract repeated sections into functions that accept explicit values and IDs:

```python
from dash import dcc, html

def metric_card(title, value, component_id):
    return html.Section([
        html.H3(title),
        html.Div(value, id=component_id, className="metric-value"),
    ], className="metric-card")

layout = html.Main([
    html.H1("Operations"),
    html.Div([
        metric_card("Open cases", "—", "open-count"),
        metric_card("Median age", "—", "median-age"),
    ], className="metric-grid"),
    dcc.Graph(id="trend"),
])
```

Reusable functions reduce duplication but must not accidentally create duplicate fixed IDs. If a component factory can be used more than once, accept an ID prefix or use a dictionary ID with a stable item key. Use `children` lists to make sections easy to inspect. A large deeply nested expression is valid, but separating page shell, filters, and visualizations is easier to maintain and test.

## CSS and layout behavior

`className` attaches CSS classes; `style` applies inline style properties. Prefer stylesheet classes for shared presentation and responsive rules, and reserve inline style for values that genuinely depend on Python data. Dash serves assets placed in the app's `assets/` directory, including CSS and JavaScript; configure asset behavior deliberately when files are large or environment-specific. Use CSS grid or flexbox for layouts that adapt to screen size, and test at the narrow widths where real users will view the page.

A graph can render at an unexpected height if the parent container has no meaningful height. Define container dimensions and responsive behavior in CSS, and consider `dcc.Graph(responsive=True)` where appropriate. Avoid fixed widths that force horizontal scrolling on smaller displays. Make focus states visible and label controls so keyboard and screen-reader users can understand them. Components have accessibility affordances, but app authors are responsible for meaningful labels, headings, contrast, and interaction flow.

## Themes and component libraries

Dash does not require a single visual design system. Dash Bootstrap Components (DBC) provides components styled with Bootstrap themes and a grid model. A typical app includes a stylesheet URL or local asset and uses `dbc.Container`, `dbc.Row`, `dbc.Col`, cards, navigation bars, and form controls. Dash Mantine Components (DMC) offers Mantine-based controls and theming through its provider components. These packages are independent dependencies: install and pin them, read the version-specific docs, and avoid mixing component versions that expect incompatible Dash features.

A theme is more than a background color. Establish typography, spacing, color tokens, border radius, and semantic status colors. In Bootstrap, select a Bootswatch or Bootstrap theme that matches the deployment's visual needs; in Mantine, configure the theme provider and design tokens. For Plotly charts, set a compatible figure template and colors so charts do not look like unrelated embedded content. A CSS theme does not automatically style Plotly's canvas/SVG internals; configure figure layout too.

Do not choose a third-party library only for one decorative widget if the dependency, styling rules, and accessibility cost outweigh the benefit. Conversely, a coherent component set often improves consistency and saves time when the app has many forms and navigation elements. Wrap framework-specific components in thin project-level factories if the app may replace a library.

## Dynamic composition and state

A layout can be a function when a fresh layout is needed, but building a huge data-dependent tree on every request is expensive. For user-driven rows, start with an empty or small container and add components through a callback. Use pattern-matching IDs for those repeated controls, and decide how their state survives navigation or refresh. Component existence and callback registration are related but not identical: callbacks should be registered at app initialization, while dynamic children appear in response to user interaction.

For tabbed interfaces, a `dcc.Tabs` component may construct all panels or display the active panel depending on how the app is built. Loading every expensive chart at once can waste work. Consider lazy-loading visible content, with callback behavior tested for initial calls and dynamically inserted components. Build the layout for the most common viewport rather than putting every control above the fold.

## Common mistakes

- Giving every reusable card or row the same static ID.
- Mixing inline styles, unrelated CSS conventions, and multiple component libraries without design tokens.
- Assuming a CSS theme changes Plotly figure colors and fonts automatically.
- Using fixed pixel widths and then discovering the dashboard is unusable on a laptop or tablet.
- Creating every expensive page component before the user navigates to it.
- Treating visual polish as a substitute for labels and accessible focus behavior.

## Production notes

Keep assets under source control, version styles with the code, and avoid embedding environment-specific URLs in stylesheets. Test layouts at representative screen sizes and with a keyboard. Pin DBC/DMC and Dash versions together, and review their changelogs before upgrades. The browser console is valuable for diagnosing missing assets, React warnings, and component property issues; server logs alone cannot show every UI problem. A lightweight visual regression check for high-value pages catches accidental layout changes after component or theme upgrades.

## Accessibility and design tokens

A usable dashboard needs a coherent reading order as well as a grid. Use one clear page heading, descriptive section headings, labels associated with each input, and visible focus states. Give icon-only actions an accessible name and explain chart intent in nearby text when the chart alone is not sufficient. Color should reinforce meaning rather than carry it alone: pair status colors with text or symbols and verify contrast in the chosen theme. These decisions matter for keyboard users, people using assistive technology, and anyone viewing a dashboard in poor lighting.

Design tokens help keep several pages consistent. Define a small palette, spacing scale, typography choices, and semantic states, then apply them through CSS variables or the selected library's theme configuration. Components from DBC and DMC do not share every prop name or styling behavior, so avoid scattering library-specific assumptions throughout the application. A thin wrapper can standardize common form fields or cards. When using an external stylesheet CDN, account for network availability and content security policy; a local, pinned asset may be more reliable for an internal product.

Responsive composition should be checked with real content, not only empty placeholders. Long labels, wide tables, translated text, and validation messages can change component sizes. Use CSS grid breakpoints or flex wrapping rather than a fixed two-column layout, and ensure filter controls remain reachable on a narrow screen. A graph that resizes should have a parent with a meaningful height. Browser developer tools can inspect computed styles and identify overflow. Include a small visual smoke check after changes to the component library or global stylesheet, because a subtle CSS reset can alter inputs and graph containers across every page.

