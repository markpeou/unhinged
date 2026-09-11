# Unhinged

A party game played on phones. No dependencies.

## Two ways to run it

**Hosted** — `index.html` + `api/kv.js`, deployed to Vercel. Open the URL,
start a room, share the 4-letter code. Works anywhere, no Wi-Fi requirement.
State lives in memory in a serverless function, so a cold start can drop a
room; rejoin with the same name to get your seat back.

**LAN** — `server.js` + `public/index.html`. One laptop, everyone on the same
Wi-Fi, no internet needed. State lives in a real process, so nothing drops.
This is the one to use at an actual party.

```bash
node server.js          # PORT=8080 to change port
```

It prints a LAN URL — `http://192.168.1.42:3000` — for everyone else to open.
First to join is the host.

Note that GitHub Pages can host neither: it serves static files only, so it
never runs `server.js` or `api/kv.js`.

## The four kinds of round

They cycle through a fixed rotation rather than one big shuffle, so the
personal ones come around reliably instead of getting buried.

**Pick a person** — "Plane goes down in the Andes. Who do we eat first?"
Everyone taps a name. Most-picked person drinks. No voting phase, so these
are fast.

**Write your own** — "What is that smell?"
Everyone types an answer. Answers appear anonymously, everyone votes, the
winner drinks.

**Play a card** — "The airline lost my luggage, which contained ___."
Dealt seven random cards, play one into the blank (two, on some prompts).
Everyone sees the filled-in sentences, votes for the worst, the winner drinks.

**Play a card about someone here** — "{player}'s search history is almost
entirely ___." A real name from the room gets slotted in each round, then
played into like a normal card round. These are the ones that end
friendships.

## Drinking rules as implemented

- Most votes drinks. Winning costs you.
- Ties mean everyone tied drinks.
- **Matching somebody else drinks.** If two people play the same card, or
  type the same answer word for word, the two submissions merge into one
  line and everyone behind it drinks — separately from and on top of the
  vote result.
- Dumping your hand for a fresh seven costs one drink. Button's on the play
  screen.

## Host controls

The host gets **Begin**, **Next round**, **Stop**, and a **Close it early /
Call the vote** button that appears whenever the round is stuck waiting on
someone who has wandered off. Use it constantly. The host badge moves
automatically if their phone drops off. The lobby shows a live roster —
names slide in as people join, tagged `you` / `host` — so the host can
visually confirm everyone's there before starting.

## Writing your own cards

Everything lives in `prompts.js`:

- `PICK` — questions answered with a person's name
- `TEXT` — questions answered by typing
- `BLACK` — prompts with blanks. Write `___` for each blank; two blanks
  means everyone plays two cards
- `PERSON` — same as `BLACK`, but with a `{player}` token that gets replaced
  by a real name from the room each round
- `WHITE` — the 265 cards people are dealt
- `PATTERN` — the round-type rotation. Edit this to change the mix.

Add strings, restart the server. Inside jokes beat every card in here, so
write thirty of your own before you play.

## Things worth knowing

- Hands are dealt independently per player rather than off one shared pile.
  That's deliberate: with 265 unique cards, a single pile would make it
  impossible for two people to hold the same card, and the duplicate rule
  would never fire.
- Phones locking is handled. The browser reconnects itself and your seat is
  held by name, so reloading puts you back exactly where you were.
- State is in memory. Restarting the server wipes scores and starts fresh.
- No authentication. Anyone on your Wi-Fi who finds the URL can join under
  any free name, which is the correct amount of security for a party.

## On the source material

The cards here are all original. Cards Against Humanity licenses its own
writing and its FAQ is explicit that it isn't reusable, so none of their
card text is in this project — only the format, which is a prompt with a
blank and a hand of cards.

Fair warning on content: the deck leans hard into drinking-game territory —
crude, dark, occasionally NSFW. That's the brief. Edit `prompts.js` down if
you're playing with a crowd that wants it tamer.
