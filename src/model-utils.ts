/**
 * Model utility functions for searching and filtering models.
 */

export interface ModelLike {
	id: string;
	name: string;
	provider: string;
}

/**
 * Find a model by exact match first, then fuzzy match.
 *
 * @param models - List of available models
 * @param search - Search string, optionally in "provider/model" format
 * @returns First matching model or undefined
 */
export function findModel<T extends ModelLike>(models: readonly T[], search: string): T | undefined {
	if (!search) return undefined;
	const [providerPart, ...modelParts] = search.split("/");
	const modelPart = modelParts.join("/");

	if (modelPart) {
		// "provider/model" format — try exact match first
		const exact = models.find((m) => m.provider === providerPart && m.id === modelPart);
		if (exact) return exact;

		// Fuzzy: provider includes term, id or name includes model part
		const lowerProvider = providerPart.toLowerCase();
		const lowerModel = modelPart.toLowerCase();
		return models.find(
			(m) =>
				m.provider.toLowerCase().includes(lowerProvider) &&
				(m.id.toLowerCase().includes(lowerModel) ||
					(m.name && m.name.toLowerCase().includes(lowerModel))),
		);
	}

	// Single term
	const term = providerPart;
	const lowerTerm = term.toLowerCase();

	// Try exact match by full id or "provider/id"
	const exact = models.find(
		(m) => m.id === term || `${m.provider}/${m.id}` === term,
	);
	if (exact) return exact;

	// Fuzzy: id, name, or provider includes term
	return models.find(
		(m) =>
			m.id.toLowerCase().includes(lowerTerm) ||
			(m.name && m.name.toLowerCase().includes(lowerTerm)) ||
			m.provider.toLowerCase().includes(lowerTerm),
	);
}

/**
 * Filter models matching a search string.
 *
 * @param models - List of models
 * @param search - Search string, optionally in "provider/model" format
 * @returns Filtered list of models
 */
export function filterModels<T extends ModelLike>(models: readonly T[], search: string): T[] {
	if (!search) return [];
	const [providerPart, ...modelParts] = search.split("/");
	const modelPart = modelParts.join("/");

	if (modelPart) {
		// "provider/model" format — match provider part AND (id or name includes model part)
		const lowerProvider = providerPart.toLowerCase();
		const lowerModel = modelPart.toLowerCase();
		return models.filter(
			(m) =>
				m.provider.toLowerCase().includes(lowerProvider) &&
				(m.id.toLowerCase().includes(lowerModel) ||
					(m.name && m.name.toLowerCase().includes(lowerModel))),
		);
	}

	// Single term — match id, name, or provider
	const lowerTerm = providerPart.toLowerCase();
	return models.filter(
		(m) =>
			m.id.toLowerCase().includes(lowerTerm) ||
			(m.name && m.name.toLowerCase().includes(lowerTerm)) ||
			m.provider.toLowerCase().includes(lowerTerm),
	);
}
