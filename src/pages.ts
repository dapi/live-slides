import { config } from './config';

const escape = (value: string) => value.replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]!);
function address(value: string, relative = false): string {
  if (!value) return '';
  if (relative && value.startsWith('/') && !value.startsWith('//')) return value;
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid public URL');
  return value;
}

/** Only this explicit allowlist reaches the public page. Never interpolate process.env. */
export function renderLanding(template: string, settings = config.public): string {
  const values: Record<string, string> = {
    PUBLIC_SITE_URL: address(settings.siteUrl),
    PUBLIC_AUTHOR_NAME: settings.authorName,
    PUBLIC_AUTHOR_URL: address(settings.authorUrl),
    PUBLIC_INTRO_VIDEO_URL: address(settings.introVideoUrl, true),
    PUBLIC_INTRO_POSTER_URL: address(settings.introPosterUrl, true),
    PUBLIC_VIDEO_HIDDEN: settings.introVideoUrl ? '' : 'hidden',
    PUBLIC_AUTHOR_HIDDEN: settings.authorUrl && settings.authorName ? '' : 'hidden',
    PUBLIC_AUTHOR_LOGO_URL: address(settings.authorLogoUrl, true),
    PUBLIC_AUTHOR_LOGO_DARK_URL: address(settings.authorLogoDarkUrl, true),
    PUBLIC_AUTHOR_LOGO_HIDDEN: settings.authorLogoUrl ? '' : 'hidden',
  };
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, name) => {
    if (!(name in values)) throw new Error('Unknown public page placeholder');
    return escape(values[name]);
  });
}
