import { defineConfig } from 'vite';

// Builds <drawing-app> and the host API as one self-contained, minified ES
// module (Lit included) for pages that embed the editor rather than run the
// PWA: `npm run build:lib` writes dist-lib/ketchup.js. Loading the module
// defines the custom elements; see README "Embedding".
//
// A plain build with an explicit input rather than library mode: library mode
// leaves ES output unminified for the sake of downstream bundlers, and this
// file is served to browsers as is.
export default defineConfig({
  publicDir: false,
  build: {
    target: 'es2021',
    outDir: 'dist-lib',
    emptyOutDir: true,
    copyPublicDir: false,
    rollupOptions: {
      input: 'src/index.ts',
      preserveEntrySignatures: 'exports-only',
      output: {
        format: 'es',
        entryFileNames: 'ketchup.js',
        inlineDynamicImports: true,
      },
    },
  },
});
