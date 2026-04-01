import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["**/*.test.ts"],
		environment: "node",
		globals: true,
		coverage: {
			provider: "v8",
			include: ["*.ts"],
			exclude: ["*.test.ts"],
		},
	},
});
