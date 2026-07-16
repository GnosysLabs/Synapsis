import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "no-restricted-globals": [
        "error",
        { name: "alert", message: "Use useAppDialog().showAlert() instead of a browser dialog." },
        { name: "confirm", message: "Use useAppDialog().showConfirm() instead of a browser dialog." },
        { name: "prompt", message: "Use useAppDialog().showPrompt() instead of a browser dialog." },
      ],
      "no-restricted-properties": [
        "error",
        ...["window", "globalThis"].flatMap((object) => [
          { object, property: "alert", message: "Use the shared in-app dialog provider." },
          { object, property: "confirm", message: "Use the shared in-app dialog provider." },
          { object, property: "prompt", message: "Use the shared in-app dialog provider." },
        ]),
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "Literal[value='beforeunload']",
          message: "Browser unload dialogs are not allowed; use an in-app navigation guard.",
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
