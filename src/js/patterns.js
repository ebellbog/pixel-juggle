export const CUSTOM_PATTERN_VALUE = 'custom';

/** Curated menu patterns - `name` is the left label; `value` is the siteswap. */
export const PATTERN_GROUPS = [
    {
        label: 'Easy',
        patterns: [
            { value: '3', name: 'Cascade' },
            { value: '51', name: 'Shower' },
            { value: '5', name: '5 Ball Cascade' },
            { value: '441', name: 'Half Box' },
        ],
    },
    {
        label: 'Medium',
        patterns: [
            { value: '4', name: '4 Ball Fountain' },
            { value: '(4,4)', name: '4 Ball Sync Fountain' },
            { value: '447', name: '447' },
            { value: '531', name: '531' },
        ],
    },
    {
        label: 'Hard',
        patterns: [
            { value: '(4,2x)*', name: 'Box' },
            { value: '534', name: '534' },
            { value: '645', name: '645' },
            { value: '97531', name: '97531' },
        ],
    },
];

/** When the display name already *is* the siteswap (e.g. "531"), skip the faded suffix. */
export function patternShowsSiteswap(name, value) {
    return name !== value;
}

export function findPattern(value) {
    for (const group of PATTERN_GROUPS) {
        for (const pattern of group.patterns) {
            if (pattern.value === value) return pattern;
        }
    }
    return null;
}
