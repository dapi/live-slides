import { expect, test } from 'bun:test';
import { config, createConfig } from '../src/config';
import { Auth, canUsePersonal, corpAvailable } from '../src/auth';
import { Sources } from '../src/sources';
import { renderLanding } from '../src/pages';

test('defaults have no private endpoint, identity or implicit secret-store entry', () => {
  const defaults = createConfig({});
  expect(defaults.auth.ownerSubject).toBe('');
  expect(defaults.auth.corpVerifyUrl).toBeUndefined();
  expect(defaults.sources.url).toBe('');
  expect(defaults.sources.scopes).toEqual([]);
  expect(defaults.sources.enabled).toBe(false);
  expect(defaults.site.enabled).toBe(false);
  expect(defaults.knowledge.databasePassEntry).toBeUndefined();
  expect(defaults.stt.elevenlabs.passEntry).toBeUndefined();
  expect(defaults.llm.apiKey).toBe('');
  expect(defaults.llm.baseUrl).toContain('127.0.0.1');
});

test('configured owner identity works and native lookalikes stay isolated', async () => {
  const previous = { ...config.auth };
  try {
    Object.assign(config.auth, createConfig({}).auth);
    expect(corpAvailable()).toBe(false);
    expect(canUsePersonal({ id: 'test', subject: 'corp:presenter', display_name: 'Owner' })).toBe(false);
    await expect(new Auth(null as any).corpLogin(new Request('http://localhost/auth/corp'))).rejects.toMatchObject({ status: 404 });
    Object.assign(config.auth, createConfig({
      CORP_VERIFY_URL: 'https://auth.example.org/verify', CORP_LOGIN_URL: 'https://auth.example.org/login',
      CORP_OWNER_USER: 'presenter', PERSONAL_SOURCE_SUBJECT: 'corp:presenter',
    }).auth);
    expect(corpAvailable()).toBe(true);
    expect(canUsePersonal({ id: 'test', subject: 'corp:presenter', display_name: 'Owner' })).toBe(true);
    expect(canUsePersonal({ id: 'test', subject: 'local:presenter', display_name: 'Owner' })).toBe(false);
    expect(canUsePersonal({ id: 'test', subject: 'corp:other', display_name: 'Owner' })).toBe(false);
    config.auth.ownerSubject = 'local:presenter';
    expect(corpAvailable()).toBe(false);
    expect(canUsePersonal({ id: 'test', subject: 'local:presenter', display_name: 'Owner' })).toBe(false);
  } finally { Object.assign(config.auth, previous); }
});

test('a URL alone never enables an unscoped private memory search', () => {
  const previous = { ...config.sources };
  try {
    Object.assign(config.sources, createConfig({ OPENVIKING_URL: 'http://127.0.0.1:1933' }).sources);
    expect(new Sources().enabled).toBe(false);
  } finally { Object.assign(config.sources, previous); }
});

test('public page substitutes only public settings and escapes HTML attributes', () => {
  const settings = createConfig({ APP_ORIGIN: 'https://slides.example.org', PUBLIC_AUTHOR_NAME: '"><script>private</script>',
    PUBLIC_AUTHOR_URL: 'https://author.example.org', PUBLIC_INTRO_VIDEO_URL: 'https://cdn.example.org/video.mp4' }).public;
  const page = renderLanding('<a href="{{PUBLIC_SITE_URL}}">{{PUBLIC_AUTHOR_NAME}}</a> {{PUBLIC_VIDEO_HIDDEN}}', settings);
  expect(page).toContain('https://slides.example.org');
  expect(page).not.toContain('<script>');
  expect(page).toContain('&quot;&gt;&lt;script&gt;');
  expect(renderLanding('{{PUBLIC_VIDEO_HIDDEN}} {{PUBLIC_AUTHOR_HIDDEN}}', createConfig({}).public)).toBe('hidden hidden');
  expect(() => renderLanding('{{PUBLIC_AUTHOR_URL}}', { ...settings, authorUrl: 'javascript:alert(1)' })).toThrow();
  expect(() => renderLanding('{{DATABASE_URL}}', settings)).toThrow();
});
