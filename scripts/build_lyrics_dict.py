"""Build the compact pronunciation dictionary used by the Lyric Helper.

Source data (downloaded once, cached in %TEMP%/waivepulse_dict_cache):
  * CMU Pronouncing Dictionary  (BSD-style licence)  github.com/cmusphinx/cmudict
  * English word frequency list (OpenSubtitles 2018)  github.com/hermitdave/FrequencyWords

Output: frontend/js/lyrics/data/cmudict-common.txt
  line 1 : "#WPDICT1 " + space-separated phoneme table (index i -> char chr(CHAR0+i))
  line 2+: word<TAB>encoded-phonemes, ordered by word frequency (most common first)
Each ARPAbet phoneme incl. stress digit (e.g. AY1, T) becomes ONE character, so
the file stays small and the browser can decode it in a few ms.

Run:  python scripts/build_lyrics_dict.py [max_words]
"""
import os, re, sys, tempfile, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(tempfile.gettempdir(), 'waivepulse_dict_cache')
OUT = os.path.join(HERE, '..', 'frontend', 'js', 'lyrics', 'data', 'cmudict-common.txt')
CMU_URL = 'https://raw.githubusercontent.com/cmusphinx/cmudict/master/cmudict.dict'
FREQ_URL = 'https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/en/en_50k.txt'
CHAR0 = 0x30  # '0' -> printable ASCII range, no tab/space/newline

VOWELS = ['AA', 'AE', 'AH', 'AO', 'AW', 'AY', 'EH', 'ER', 'EY', 'IH', 'IY', 'OW', 'OY', 'UH', 'UW']
CONS = ['B', 'CH', 'D', 'DH', 'F', 'G', 'HH', 'JH', 'K', 'L', 'M', 'N', 'NG', 'P', 'R',
        'S', 'SH', 'T', 'TH', 'V', 'W', 'Y', 'Z', 'ZH']
TABLE = [v + s for v in VOWELS for s in '012'] + CONS


def fetch(url, name):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, name)
    if not os.path.exists(path):
        print('downloading', url)
        urllib.request.urlretrieve(url, path)
    with open(path, encoding='utf-8', errors='replace') as f:
        return f.read()


def main():
    max_words = int(sys.argv[1]) if len(sys.argv) > 1 else 30000
    idx = {p: i for i, p in enumerate(TABLE)}
    assert CHAR0 + len(TABLE) < 127
    cmu = {}
    for line in fetch(CMU_URL, 'cmudict.dict').splitlines():
        line = line.split('#')[0].strip()
        if not line:
            continue
        word, *phones = line.split()
        if '(' in word:          # alternate pronunciation -> keep the first only
            continue
        if not re.fullmatch(r"[a-z]+(?:'[a-z]+)?", word):
            continue
        cmu[word] = phones
    out, seen = [], set()
    for line in fetch(FREQ_URL, 'en_50k.txt').splitlines():
        parts = line.split()
        if not parts:
            continue
        w = parts[0].lower()
        if w in seen or w not in cmu:
            continue
        if len(w) == 1 and w not in ('a', 'i', 'o'):
            continue
        seen.add(w)
        out.append(w + '\t' + ''.join(chr(CHAR0 + idx[p]) for p in cmu[w]))
        if len(out) >= max_words:
            break
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='ascii', newline='\n') as f:
        f.write('#WPDICT1 ' + ' '.join(TABLE) + '\n')
        f.write('\n'.join(out) + '\n')
    print(f'{len(out)} words -> {os.path.normpath(OUT)} ({os.path.getsize(OUT)/1024:.0f} KB)')


if __name__ == '__main__':
    main()
