// Match configured desktop IDs; source titles cover notification-only clients.
export function isMessagingSource(appId, title, configured) {
    const normalize = value => String(value ?? '').toLowerCase().replace(/\.desktop$/, '');
    const id = normalize(appId);
    const name = normalize(title);
    return configured.some(entry => {
        const candidate = normalize(entry);
        const short = candidate.split('.').at(-1);
        return Boolean(candidate) && (id === candidate || name === candidate || name === short);
    });
}
