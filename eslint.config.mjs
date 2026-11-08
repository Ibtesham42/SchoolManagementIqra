import next from "eslint-config-next";

/** Layer rules (docs/SYSTEM_ARCHITECTURE.md §3). Also checked, with cycle detection, by `npm run check:deps`. */
const layer = (files, forbidden, message) => ({
  files,
  rules: {
    "no-restricted-imports": [
      "error",
      { patterns: forbidden.map((dir) => ({ group: [`@/${dir}/*`, `@/${dir}`], message })) },
    ],
  },
});

const config = [
  ...next,
  { ignores: ["src/generated/**", ".next/**", "node_modules/**"] },
  {
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          // String.raw: the "$" must reach the selector regex escaped. (A plain string turned "\$" into "$",
          // producing /^$(…)$/ which never matched — this rule silently did nothing until 2026-11-08.)
          selector: String.raw`MemberExpression[property.name=/^\$(queryRawUnsafe|executeRawUnsafe)$/]`,
          message: "Unsafe raw SQL is forbidden (SECURITY.md). Use the tagged-template $queryRaw / $executeRaw.",
        },
      ],
    },
  },
  layer(["src/lib/**"], ["modules", "app", "components", "chatbot"], "lib/ is the bottom layer: it may not import modules, app, components or chatbot."),
  layer(["src/modules/**"], ["app", "components"], "Domain modules may not import UI or route code."),
  layer(["src/components/**"], ["app", "modules"], "Components receive data via props; they may not import routes or domain services."),
  // ADR-011: the public chatbot must be structurally unable to reach ERP data.
  layer(["src/chatbot/**"], ["modules", "app", "components"], "Chatbot code may not import ERP modules, routes or UI."),
];

export default config;
