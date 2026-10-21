"""Italian numbers, times, percentages and amounts in words, as a reader says them: Pocket reads
the dots and colons of "1.250" and "14:30" as pauses.

    python italiano.py "Il 9 ottobre alle 14:30 abbiamo 1.250 utenti, il 37%."
"""

import re
import sys

UNITS = "zero uno due tre quattro cinque sei sette otto nove dieci undici dodici tredici quattordici quindici sedici " \
        "diciassette diciotto diciannove".split()
TENS = "_ _ venti trenta quaranta cinquanta sessanta settanta ottanta novanta".split()


def number(n: int) -> str:
    """Cardinal number in words, up to the billions."""
    if n < 20:
        return UNITS[n]
    if n < 100:
        tens, unit = divmod(n, 10)
        word = TENS[tens]
        if unit in (1, 8):  # ventuno, ventotto: the tens lose their vowel
            word = word[:-1]
        return word + (UNITS[unit] if unit else "")
    if n < 1000:
        hundreds, rest = divmod(n, 100)
        head = "cento" if hundreds == 1 else UNITS[hundreds] + "cento"
        if rest and str(rest).startswith("8"):  # centottanta
            head = head[:-1]
        return head + (number(rest) if rest else "")
    for size, one, many in ((10 ** 9, "un miliardo", "miliardi"), (10 ** 6, "un milione", "milioni"),
                            (1000, "mille", "mila")):
        if n >= size:
            head, rest = divmod(n, size)
            word = one if head == 1 else number(head) + ("" if size == 1000 else " ") + many
            return word + ((" " if size > 1000 else "") + number(rest) if rest else "")
    return str(n)


def words(text: str) -> str:
    """Numbers, times, percentages and amounts written out; the rest left as it is."""
    text = re.sub(r"(\d{1,2}):(\d{2})", lambda m: f"{number(int(m[1]))} e {number(int(m[2]))}" if int(m[2]) else
                  number(int(m[1])), text)
    text = re.sub(r"\b(\d{1,3}(?:\.\d{3})+)\b", lambda m: m[1].replace(".", ""), text)  # 1.250: thousands
    # a decimal comma is "virgola"; a dot left after the thousands (versions, English decimals) is "punto"
    text = re.sub(r"(\d+)([.,])(\d+)", lambda m: f"{number(int(m[1]))} {'virgola' if m[2] == ',' else 'punto'} " + (
        " ".join(number(int(d)) for d in m[3]) if len(m[3]) > 2 or m[3].startswith("0") else number(int(m[3]))), text)
    text = re.sub(r"(\d+)\s*%", lambda m: f"{number(int(m[1]))} per cento", text)
    text = re.sub(r"€\s*(\d+)|(\d+)\s*€", lambda m: f"{number(int(m[1] or m[2]))} euro", text)
    return re.sub(r"\d+", lambda m: number(int(m[0])), text)


if __name__ == "__main__":
    print(words(" ".join(sys.argv[1:])))
