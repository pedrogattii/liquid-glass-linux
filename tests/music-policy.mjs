import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const {nativeMusicApp, playerPresent, selectPlayerName, mediaMetadata,
    mediaCapabilities, artworkUriAllowed, localArtworkAllowed, MAX_COVER_BYTES,
    orderPlayers} = await import(`data:text/javascript;base64,${Buffer.from(await readFile(new URL('../extensions/liquid-island@pedrogatti.local/lib/musicPolicy.js', import.meta.url))).toString('base64')}`);

const spotify = {name: 'org.mpris.MediaPlayer2.spotify', desktopEntry: 'spotify',
    present: true, connected: true, playing: false};
const vlc = {name: 'org.mpris.MediaPlayer2.vlc', desktopEntry: 'vlc',
    present: true, connected: true, playing: true};
assert.equal(selectPlayerName([spotify, vlc]), vlc.name, 'playing wins without vendor bias');
assert.equal(selectPlayerName([spotify, vlc], {name: spotify.name}), spotify.name,
    'manual paused selection survives another app playing');
assert.equal(selectPlayerName([vlc], {name: spotify.name}), vlc.name,
    'a vanished manual choice yields to an available player');
assert.equal(selectPlayerName([{...vlc, playing: false}, spotify], null, vlc.name), vlc.name,
    'automatic selection remains stable among equally idle players');
assert.equal(selectPlayerName([spotify], {name: 'app:spotify.desktop', desktopEntry: 'spotify.desktop'}),
    spotify.name, 'startup choice follows the same native app into MPRIS');
assert.deepEqual(orderPlayers([vlc, spotify]).map(player => player.name), [spotify.name, vlc.name]);
assert.equal(playerPresent({connected: true}), true, 'paused/background MPRIS owner stays present');
assert.equal(playerPresent({native: true, appRunning: true}), true, 'native startup is present before MPRIS');
assert.equal(playerPresent({native: true, ownerAlive: true}), true, 'native owner survives temporary unregister');
assert.equal(playerPresent({native: true}), false, 'actual exit removes presence');
assert.equal(playerPresent({appRunning: true, ownerAlive: true}), false,
    'browser process alone never creates a media session');
assert.equal(nativeMusicApp('spotify.desktop'), true);
assert.equal(nativeMusicApp('com.spotify.Client.desktop'), true);
assert.equal(nativeMusicApp('org.gnome.Music.desktop', 'AudioVideo;Music;'), true);
assert.equal(nativeMusicApp('vlc.desktop', 'Audio;Player;'), true);
assert.equal(nativeMusicApp('chrome.desktop', 'WebBrowser;Audio;Player;Music;'), false);
const meta = mediaMetadata({'xesam:artist': 'Single artist', 'mpris:length': -7});
assert.equal(meta.title, 'Sin título');
assert.equal(meta.artist, 'Single artist');
assert.equal(meta.length, 0);
assert.equal(mediaMetadata({}).artist, 'Reproductor multimedia');
assert.equal(mediaMetadata({'mpris:length': NaN}).length, 0);
assert.ok(Object.values(mediaCapabilities(() => true, false)).every(value => value === false));
assert.equal(mediaCapabilities((key, fallback) => key === 'CanControl' ? false : fallback, true).canPlay, false);
assert.equal(artworkUriAllowed('http://example.com/cover.png'), false);
assert.equal(artworkUriAllowed('https://example.com/cover.png'), true);
assert.equal(artworkUriAllowed('file:///tmp/cover.png'), true);
assert.equal(artworkUriAllowed('file://server/share/cover.png'), false);
assert.equal(localArtworkAllowed({regular: true, size: 1024, contentType: 'image/png'}), true);
for (const fields of [{regular: false}, {size: MAX_COVER_BYTES + 1}, {contentType: 'text/plain'}]) {
    assert.equal(localArtworkAllowed({regular: true, size: 1024, contentType: 'image/png', ...fields}), false);
}
console.log('music policy: selection, presence, metadata, capabilities and artwork checks passed');
