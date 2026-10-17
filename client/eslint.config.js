// @ts-check

import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    {
        // Standalone `ignores` objects are global; tests/scripts holds plain-JS
        // Node scripts that run outside type-aware linting.
        ignores: ['eslint.config.js', 'build/**', 'node_modules/**', 'tests/scripts/**'],
    },
    eslint.configs.recommended,
    ...tseslint.configs.strictTypeChecked,
    ...tseslint.configs.stylisticTypeChecked,
    {
        languageOptions: {
            parserOptions: {
                project: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            // Possible Problems (https://eslint.org/docs/latest/rules/#possible-problems)

            'no-await-in-loop': 'error',                 // In almost all cases, Promise.all() should be used instead.
            'no-template-curly-in-string': 'error',      // Easy to forget to use backticks.
            'no-unreachable-loop': 'error',              // Why have a loop if it only executes once?
            'no-useless-assignment': 'error',            // Surprised TypeScript doesn't have an option for this one.
            'require-atomic-updates': 'error',           // Surprised ESLint has an option for this one.
            
            // Suggestions (https://eslint.org/docs/latest/rules/#suggestions)

            'camelcase': 'off',                          // Better type-aware naming rules are below.
            'class-methods-use-this': 'off',             // Better type-aware class rules are below.
            'default-case-last': 'error',                // Default cases should always be last.
            'eqeqeq': 'error',                           // Strict equal (===) is much more predictable.
            'no-var': 'error',                           // Use let or const instead, var is never needed.

            // TypeScript Specific (https://typescript-eslint.io/rules/?=xstrict-xstylistic-xdeprecated)

            '@typescript-eslint/explicit-function-return-type': 'error',    // Explicit returns are more readable.
            '@typescript-eslint/explicit-member-accessibility': 'error',    // Public methods should be explicit.
            '@typescript-eslint/member-ordering': 'error',                  // Consistenty of class members is nice.
            '@typescript-eslint/naming-convention': [
                'error',
                {
                    'selector': 'default',
                    'format': ['strictCamelCase', 'PascalCase', 'UPPER_CASE'],
                    'leadingUnderscore': 'allow',
                },
                {
                    // Types should all be in pascal case.
                    'selector': 'typeLike',
                    'format': ['PascalCase'],
                },
                {
                    // Same with enums.
                    'selector': 'enumMember',
                    'format': ['PascalCase'],
                }
            ],
            '@typescript-eslint/prefer-readonly': 'error',                  // Immutability is always preferred.
            '@typescript-eslint/switch-exhaustiveness-check': 'error',      // Exhaustiveness checks are always good.
        }
    },
    {
        // serve.mjs is production Node code (the `start` script entry),
        // linted type-aware here and type-CHECKED by tsc with checkJs
        // (see tsconfig.node.json). Two rules cannot read JSDoc and have
        // no TS annotation syntax in plain JavaScript:
        // - no-undef: subsumed by checkJs (Node globals come from
        //   @types/node there); typescript-eslint itself disables this
        //   rule for every file type it type-checks.
        // - explicit-function-return-type: serve.mjs documents every
        //   return type as JSDoc @returns, which tsc enforces.
        files: ['serve.mjs'],
        rules: {
            'no-undef': 'off',
            '@typescript-eslint/explicit-function-return-type': 'off',
        },
    },
);
