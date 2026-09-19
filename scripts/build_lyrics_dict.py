"""Build the compact pronunciation dictionary used by the Lyric Helper.

Source data (downloaded once, cached in %TEMP%/waivepulse_dict_cache; after the
first run the build works fully offline, and the output file is vendored so the
browser never needs the network):
  * CMU Pronouncing Dictionary  (BSD-style licence)  github.com/cmusphinx/cmudict
  * English word frequency list (OpenSubtitles 2018, MIT)  github.com/hermitdave/FrequencyWords
  Proper-noun / brand detection (see is_proper below):
  * Hunspell en_US from SCOWL (MIT/BSD-style)  github.com/wooorm/dictionaries
      case-preserving: "rose" is stored lowercase, "Dwight"/"Friday" capitalised
  * ENABLE word list (public domain)  github.com/dolph/dictionary
      lowercase common words only - no names, places or brands
  * US Census 1990 first names (public domain)  github.com/arineng/arincli
  * NAME_WORDS below: a small hand-picked list of names that ALSO have a rare
    lowercase meaning (john, tom, wright...), which the lists above can't catch.

Why not wordfreq? wordfreq folds case, so it can't tell "Rose" from "rose".

Output: frontend/js/lyrics/data/cmudict-common.txt
  line 1 : "#WPDICT2 " + space-separated phoneme table (index i -> char chr(CHAR0+i))
  line 2+: word<TAB>encoded-phonemes, ordered by word frequency (most common first)
  A word written with a Capital first letter is a proper noun / brand: it is
  still used for syllable counts but never suggested by the rhyme finder.
Each ARPAbet phoneme incl. stress digit (e.g. AY1, T) becomes ONE character, so
the file stays small and the browser can decode it in a few ms.

Run:  python scripts/build_lyrics_dict.py [max_words] [--report]
"""
import os, re, sys, tempfile, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(tempfile.gettempdir(), 'waivepulse_dict_cache')
OUT = os.path.join(HERE, '..', 'frontend', 'js', 'lyrics', 'data', 'cmudict-common.txt')
CMU_URL = 'https://raw.githubusercontent.com/cmusphinx/cmudict/master/cmudict.dict'
FREQ_URL = 'https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/en/en_50k.txt'
HUNSPELL_URL = 'https://raw.githubusercontent.com/wooorm/dictionaries/main/dictionaries/en/index.dic'
ENABLE_URL = 'https://raw.githubusercontent.com/dolph/dictionary/master/enable1.txt'
FIRST_NAME_URLS = [
    ('https://raw.githubusercontent.com/arineng/arincli/master/lib/male-first-names.txt', 'census-male.txt'),
    ('https://raw.githubusercontent.com/arineng/arincli/master/lib/female-first-names.txt', 'census-female.txt'),
]
CHAR0 = 0x30  # '0' -> printable ASCII range, no tab/space/newline

VOWELS = ['AA', 'AE', 'AH', 'AO', 'AW', 'AY', 'EH', 'ER', 'EY', 'IH', 'IY', 'OW', 'OY', 'UH', 'UW']
CONS = ['B', 'CH', 'D', 'DH', 'F', 'G', 'HH', 'JH', 'K', 'L', 'M', 'N', 'NG', 'P', 'R',
        'S', 'SH', 'T', 'TH', 'V', 'W', 'Y', 'Z', 'ZH']
TABLE = [v + s for v in VOWELS for s in '012'] + CONS

# Capitalised words that are fine to suggest in lyrics anyway.
KEEP = set('''
i o a ok okay gonna wanna gotta kinda sorta outta lotta dunno gimme lemme ya yeah yep nope
whoa woah ohh ahh ooh oooh uh huh mm hmm
monday tuesday wednesday thursday friday saturday sunday
january february march april may june july august september october november december
christmas god heaven hell tv internet online email
as grey independence reunion honorable reconstruction reformation proverbs
oughta alright allright thankyou voiceover cyber hmmm uhh dumbass arsehole shithole
'''.split())

# Names/brands that also have a (rare) lowercase meaning, so the word lists
# above keep them. Hand-picked from the ~1,000 overlaps in the top 30k words.
NAME_WORDS = set('''
john jack joe charlie mike tom peter ben henry harry bob paris nick jimmy tony lee billy jane
johnny tommy jake martin bobby anna al ed maria jerry matt alan kelly laura carl rick carter
louis josh ted dean hank joey jones morgan terry jesse mac molly jo parker joseph hong donna
charlotte jordan lewis brad nancy beth jess cooper mickey ralph cole maya toby alexander
victoria ruth marshall nelson sonny riley gloria warren logan mel graham colin spencer bonnie
jill franklin benny troy rex murphy perry romeo bailey kent pam mick collins stella benjamin
veronica vera morris phoebe kay erica patty carmen lin kirk pedro chang daphne sheila dee
clarence florence chad palmer willy marc fletcher tucker otto louie tanner alec griffin kane
sal marge missy hogan devon marcel gilbert apollo rogers dexter cory tammy chandler shelly
barbie mack ava tate milo lacey newton saul tiffany abigail billie mae freeman merlin brooks
jasper fritz brent felicity charley maxwell buffy warner gibson lulu dalton kris timothy
sanders holden monte santos lars trey ariel luna alma ginny brock kerry madeleine colleen
marguerite derrick dirk davy nellie dominique nelly moira matilda roscoe celeste bertha garth
waldo johannes maud emery jacky scottie merle mavis carlin booker wynn clementine georgette
dominick rickey eugenia althea magdalene mamie mollie bonita aline rhea aggie nona britt
christie nestor smith wright miller davies morales silva batman einstein napoleon sherlock
madonna jagger leno bilbo honda ritz hercules caesar romans congress berlin boston oxford
holland jersey brazil geneva warsaw bristol manila colorado savannah wellington hamburg
morocco congo bologna toledo valencia labrador tripoli yonkers cordoba bordeaux riviera
pacific dutch german french greek swiss danish welsh catholic jew jewish bible
mars wainwright myers byers
'''.split())

# Lyric spellings that aren't in the word lists but are real words.
SUFFIXES = ("'s", 's', 'es', 'ed', 'd', 'ing', 'er', 'ers', 'est', 'ly', 'y', 'ies', 'ied')


def fetch(url, name):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, name)
    if not os.path.exists(path):
        print('downloading', url)
        urllib.request.urlretrieve(url, path)
    with open(path, encoding='utf-8', errors='replace') as f:
        return f.read()


def load_case_lists():
    """(lower, cap): lowercase and Capitalised stems from Hunspell en_US."""
    lower, cap = set(), set()
    for line in fetch(HUNSPELL_URL, 'hunspell_en_US.dic').splitlines()[1:]:
        w = line.split('/')[0].strip()
        if not w or not w.isalpha():
            continue
        if w.islower():
            lower.add(w)
        elif w[0].isupper() and w[1:].islower():
            cap.add(w.lower())
    return lower, cap


def _stems(w):
    yield w
    for suf in SUFFIXES:
        if w.endswith(suf) and len(w) - len(suf) >= 3:     # 'myers' must not reduce to 'my'
            b = w[:-len(suf)]
            yield b
            if suf in ('ies', 'ied', 'y'):
                yield b + 'y'
            if suf in ('ed', 'ing', 'er', 'est', 'd'):
                yield b + 'e'
                if len(b) > 2 and b[-1] == b[-2]:
                    yield b[:-1]          # stopped -> stop
    if w.endswith('in'):
        yield w + 'g'                     # goin -> going
    if 'our' in w:
        yield w.replace('our', 'or')      # favourite -> favorite
    if 'ise' in w:
        yield w.replace('ise', 'ize')


def make_classifier():
    h_lower, h_cap = load_case_lists()
    enable = set(fetch(ENABLE_URL, 'enable1.txt').split())
    first = set()
    for url, name in FIRST_NAME_URLS:
        first |= {x.strip().lower() for x in fetch(url, name).splitlines() if x.strip()}

    def in_any(w, lex):
        return any(s in lex for s in _stems(w))

    def is_proper(w):
        """Proper noun / brand / not-a-common-word -> True."""
        if "'" in w or any(s in KEEP for s in _stems(w)):   # sundays, fridays
            return False
        if w in NAME_WORDS:
            return True
        # 1. Not a common lowercase word anywhere (dwight, walmart, michael, york)
        if not in_any(w, enable) and not in_any(w, h_lower):
            return True
        # 2. Hunspell only knows it Capitalised, and its only lowercase support is
        #    the Scrabble-style ENABLE list or it's a census first name (joe, ben).
        if not in_any(w, h_lower) and (w in h_cap or w in first):
            return True
        return False
    return is_proper


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    report = '--report' in sys.argv
    max_words = int(args[0]) if args else 30000
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
    is_proper = make_classifier()
    out, seen, proper = [], set(), []
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
        shown = w
        if is_proper(w):
            proper.append(w)
            shown = w[0].upper() + w[1:]
        out.append(shown + '\t' + ''.join(chr(CHAR0 + idx[p]) for p in cmu[w]))
        if len(out) >= max_words:
            break
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='ascii', newline='\n') as f:
        f.write('#WPDICT2 ' + ' '.join(TABLE) + '\n')
        f.write('\n'.join(out) + '\n')
    print(f'{len(out)} words ({len(proper)} flagged as names/brands) -> '
          f'{os.path.normpath(OUT)} ({os.path.getsize(OUT)/1024:.0f} KB)')
    if report:
        print('first 400 flagged:', ' '.join(proper[:400]))


if __name__ == '__main__':
    main()
