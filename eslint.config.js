import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
	{ ignores: ["node_modules/**"] },
	js.configs.recommended,
	...tseslint.configs.recommendedTypeChecked,
	{
		languageOptions: {
			parserOptions: {
				projectService: { allowDefaultProject: ["eslint.config.js"] },
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			"@typescript-eslint/no-non-null-assertion": "error",
			"@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
		},
	},
	{
		files: ["**/*.mjs", "**/*.cjs"],
		languageOptions: {
			globals: {
		commonjs: "readonly",
				console: "readonly",
				fetch: "readonly",
				module: "readonly",
				process: "readonly",
				require: "readonly",
				setTimeout: "readonly",
				URL: "readonly",
				__dirname: "readonly",
			},
		},
		rules: {
			...tseslint.configs.disableTypeChecked.rules,
			"@typescript-eslint/no-require-imports": "off",
			"no-undef": "off",
		},
	},
);
