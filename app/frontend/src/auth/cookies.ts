export function getCookie(name: string): string | null {
    const match = document.cookie
        .split('; ')
        .find((entry) => entry.startsWith(`${name}=`));
    return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

export function setCookie(name: string, value: string, maxAgeSeconds: number) {
    const secure = window.location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${name}=${encodeURIComponent(value)}; Max-Age=${maxAgeSeconds}; Path=/; SameSite=Lax${secure}`;
}

export function removeCookie(name: string) {
    document.cookie = `${name}=; Max-Age=0; Path=/; SameSite=Lax`;
}
