import { loadContact, parseContact } from './contact.js';

const ok = {
  name: 'Emmanuel Ajobo',
  headline: 'Backend developer',
  links: [
    { label: 'GitHub', href: 'https://github.com/EmmanuelAjobo' },
    { label: 'LinkedIn', href: 'https://www.linkedin.com/in/someone' },
    { label: 'Email', href: 'mailto:hello@example.com' },
  ],
};

describe('parseContact', () => {
  it('keeps a good contact as it is', () => {
    expect(parseContact(ok)).toEqual(ok);
  });

  it('works with no links and no headline (a name alone is still a footer)', () => {
    expect(parseContact({ name: 'A' })).toEqual({
      name: 'A',
      headline: '',
      links: [],
    });
  });

  it.each([
    null,
    undefined,
    'text',
    42,
    [],
    {},
    { name: '' },
    { name: '   ' },
    { name: 5 },
  ])('has nothing to show for %j', (raw) => {
    expect(parseContact(raw)).toBeUndefined();
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'https://evil.example/profile',
    'https://github.com.evil.example/x',
    'https://user:secret@github.com/EmmanuelAjobo',
    'https://github.com@evil.example/x',
    'http://github.com/EmmanuelAjobo',
    '//github.com/EmmanuelAjobo',
    'mailto:a@b.com?subject=x',
    'mailto:not-an-address',
    'ftp://github.com/x',
    '',
  ])('quietly drops a link to %s', (href) => {
    const contact = parseContact({
      ...ok,
      links: [{ label: 'X', href }, ok.links[0]],
    });
    expect(contact?.links).toEqual([ok.links[0]]);
  });

  it('allows a link to a page on this site', () => {
    expect(
      parseContact({ ...ok, links: [{ label: 'Docs', href: '/docs' }] })?.links,
    ).toHaveLength(1);
  });

  it('drops links that are malformed (wrong types, missing or empty labels, too-long labels)', () => {
    const contact = parseContact({
      name: 'A',
      links: [
        null,
        'string',
        { label: 5, href: 'https://github.com/x' },
        { label: 'No href' },
        { label: '  ', href: 'https://github.com/x' },
        { label: 'x'.repeat(31), href: 'https://github.com/x' },
        { label: 'Fine', href: 'https://github.com/x' },
      ],
    });
    expect(contact?.links).toEqual([
      { label: 'Fine', href: 'https://github.com/x' },
    ]);
  });

  it('bounds how many links and how much text it takes', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      label: `L${i}`,
      href: 'https://github.com/x',
    }));
    const contact = parseContact({
      name: 'n'.repeat(500),
      headline: 'h'.repeat(500),
      links: many,
    });
    expect(contact?.links).toHaveLength(8);
    expect(contact?.name).toHaveLength(140);
    expect(contact?.headline).toHaveLength(140);
  });

  it('does not treat "links" that is not a list as a list', () => {
    expect(
      parseContact({ name: 'A', links: 'https://github.com/x' })?.links,
    ).toEqual([]);
  });
});

describe('loadContact', () => {
  const answer =
    (body, status = 200) =>
    () =>
      Promise.resolve(new Response(JSON.stringify(body), { status }));

  it('reads /contact.json from this site', async () => {
    const calls = [];
    const fetchImpl = (path) => {
      calls.push(path);
      return answer(ok)();
    };
    expect(await loadContact(fetchImpl)).toEqual(ok);
    expect(calls).toEqual(['/contact.json']);
  });

  it('gives undefined (no footer) when the file is missing, broken, or the network fails', async () => {
    expect(await loadContact(answer({}, 404))).toBeUndefined();
    expect(
      await loadContact(() =>
        Promise.resolve(new Response('not json', { status: 200 })),
      ),
    ).toBeUndefined();
    expect(
      await loadContact(() => Promise.reject(new TypeError('offline'))),
    ).toBeUndefined();
  });
});
