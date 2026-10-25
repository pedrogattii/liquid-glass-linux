// Validate JSON before GLib.Variant construction: Variant constructors coerce values.
export const MAX_PROFILE_STRING_BYTES = 1024 * 1024;
export const MAX_PROFILE_ARRAY_ITEMS = 1000;

const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const record = value => value !== null && typeof value === 'object' &&
    !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));

function validString(value) {
    return typeof value === 'string' && value.length <= MAX_PROFILE_STRING_BYTES &&
        new TextEncoder().encode(value).length <= MAX_PROFILE_STRING_BYTES;
}

export function validateProfileTypes(profile, descriptors) {
    if (!record(profile) || Object.keys(profile).length !== 3 ||
        !own(profile, 'format') || profile.format !== 'liquid-glass' ||
        !own(profile, 'version') || profile.version !== 1 ||
        !own(profile, 'settings') || !record(profile.settings))
        throw new Error('Formato de ajustes no compatible.');
    if (!record(descriptors))
        throw new Error('Descriptores de ajustes no válidos.');

    // Build a new result and never write to settings or inputs during validation.
    return Object.entries(profile.settings).map(([key, value]) => {
        if (!own(descriptors, key))
            throw new Error(`Ajuste desconocido: ${key}.`);
        const type = descriptors[key]?.type;
        let valid;
        switch (type) {
        case 'b':
            valid = typeof value === 'boolean';
            break;
        case 's':
            valid = validString(value);
            break;
        case 'i':
            valid = Number.isInteger(value) && value >= -2147483648 && value <= 2147483647;
            break;
        case 'd':
            valid = typeof value === 'number' && Number.isFinite(value);
            break;
        case 'as':
            valid = Array.isArray(value) && value.length <= MAX_PROFILE_ARRAY_ITEMS &&
                Array.from(value).every(validString);
            break;
        default:
            throw new Error(`Tipo de ajuste no compatible para ${key}: ${String(type)}.`);
        }
        if (!valid)
            throw new Error(`Tipo o tamaño de valor no válido para ${key} (${type}).`);
        return [key, Array.isArray(value) ? [...value] : value];
    });
}
