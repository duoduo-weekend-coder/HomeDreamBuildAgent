# Demo script: Home Video Studio walk-through

About 7 minutes, plus questions. **Do** = what you click. **Say** = what you say (in your own words is fine).
A real job takes about 4 minutes, so you start one early and show a finished one while it runs.

---

## Before you present (15 minutes ahead)

- [ ] Restart the studio so it has the latest templates: `python3 app/server.py`, then open http://localhost:8000.
- [ ] **Pre-make a finished video** with the exact settings you'll demo (Process + final, 15 s, Vertical, highlight
      "Built in 10 months, on time", Recommended music, ElevenLabs). That's your "one I made earlier". Watch it once.
- [ ] Also keep `data/preview/styles/vibe15.mp4` and `walk15.mp4` open in a player as a backup.
- [ ] Footage path ready to paste: `/Users/chenge/Downloads/one_home_folder`
- [ ] Voice settings shows ElevenLabs (Olena). Sound on and audible to the room.
- [ ] Browser zoom about 110%; close other tabs; turn on Do Not Disturb.

---

## 1. The problem (30 s)

**Do:** Start on the studio home page.

**Say:**
> "Dream Home Build builds about fifteen custom homes. Over two years they collected thousands of drone clips and
> site photos, and their Instagram is almost empty. Nobody on a job site has time to edit reels.
> And what they want to prove — on budget, quality work, on time — is exactly what that footage shows.
> So we built an AI video studio: point it at the footage, pick a story, and it makes a finished reel."

## 2. Footage (30 s)

**Do:** Paste the folder path into **Footage**.

**Say:**
> "This can be a Google Drive link or a folder on the Mac. This one is a real project: about 280 shots over 16 shoot
> days, drone clips, iPhone videos and photographer stills, unsorted and unnamed.
> The agent never needs the builder to organise anything. It catalogues the folder once:
> - every shot gets a room or build stage and a quality grade;
> - duplicates are grouped and only the best of each scene is kept (141 interior photos became 95 scenes);
> - anything unpostable is excluded: mirror selfies, blurry frames, a visible house number."

## 3. Pick a story (60 s)

**Do:** Hover each **Story** card, then select **Process + final**.

**Say:**
> "We studied what actually performs for home builders and turned it into four stories.
> - **Process + final** is copied from a real builder reel. It gives you a quick taste of the framing, then a long
>   payoff of the finished home, cut on the beat of the music.
> - **Vibe final show** is a fast mood reel. It opens with a five-cut flash teaser, which is also taken from a reference reel.
> - **Drone + process** is 'this was dirt' told from the sky.
> - **Walk-through** is a narrated tour in real walking order.
> The shot order on each card is the actual recipe the agent follows."

**Do:** Leave **15 s** and **Vertical** selected.

> "Fifteen seconds, vertical for Reels. You can tick several and get every combination in one go."

## 4. Your message (30 s)

**Do:** Type into **Highlight message**: `Built in 10 months, on time`

**Say:**
> "This is the one thing the builder wants people to remember. It's guaranteed to appear: it's the opening title and the
> first line the narrator speaks. The agent checks a frame to confirm it's on screen, not cut off.
> It never invents claims; the numbers come from the builder."

*(Optional:* click the microphone in the field and say it instead: "or just say it, it's built for people on a job site.")

## 5. Music and voice (45 s)

**Do:** Open **Music**. Show the list, leave **Recommended: Breath of spring**, and click **Preview**. Let it play a few
seconds, then stop.

**Say:**
> "Music is picked for the story's pace: a warm track that swells for Process + final, an upbeat 137 bpm track for the vibe reel.
> The preview plays the exact section the video will use. The studio finds each song's best part and the tempo,
> so every cut lands on the beat. We measured it: every cut is within one frame.
> And if a track's license is unknown, it says so in red. We don't want the builder posting music they can't use."

**Do:** Point at **Narrator: ElevenLabs: Olena**.

> "The voiceover is ElevenLabs. Every word becomes a burned-in subtitle, because most people watch Reels muted."

## 6. Make it (30 s)

**Do:** Click **Make video**. The job page opens with the cartoon house building and the five steps.

**Say:**
> "Now an AI agent takes over. It's Claude, running our video skill, and nobody has to answer questions:
> it looks through the footage, chooses the shots, writes the story and voiceover, renders, then checks every frame.
> You can watch its log live. This takes about four minutes and costs about a dollar.
> While it works, here's one I made earlier with the same settings."

## 7. The result (2 min)

**Do:** Go back with **All videos** and open your pre-made job. Play the video with sound.

**Say, pointing at moments as they pass:**
- **First second:** "The hook: the site, with the builder's message on screen and spoken."
- **The cuts:** "Hear how the cuts sit on the music, framing first, then the finished house."
- **A straight wall:** "Every photo was straightened automatically: tilted verticals and lens keystone corrected."
- **The subtitles:** "Word-by-word subtitles in the brand font, timed to the voice."
- **The ending:** "And it never ends on a blank card. The last shot is the house, with *Budget, quality, on time*,
  *triplezbuild.com* and *DM us, link in bio*, and the narrator says it too."

**Do:** Scroll the panel beside the video: **Caption** (click **Copy caption**), **Narration**, **Shot list**, **Usage**.

**Say:**
> "Everything you need to post is here: the description with the website and hashtags, ready to copy, and the full
> narration script. The shot list says which original file each moment came from.
> There's also a metadata file for the posting step that lists every source file and time range used."

## 8. Ask for a change (45 s)

**Do:** In **Changes**, type `Make the opening shorter and end on the rooftop deck`, then send it.

**Say:**
> "If you don't like something, just say so, in plain English or by voice. The same agent edits its storyboard and
> re-renders, and the video updates in place with a new revision. No timeline, no editing software."

## 9. Back to the live job (30 s)

**Do:** Open the job you started in step 6. If it's done, play the first seconds. If not, show the log and the house.

**Say:**
> "And here's the one we started live: same footage, a fresh cut."

## 10. Where this goes (45 s)

**Say:**
> "Today the studio turns raw footage into finished, on-brand reels in minutes.
> The next pieces are already designed, and part of them is built in this repo:
> - **Scheduling:** approved reels publish to Instagram Monday to Friday.
> - **The CRM agent:** when someone comments or sends 'DM us', it answers their questions, collects the
>   project details and books a call on the team's calendar. It never quotes a price, and it texts the team.
> - **Not niche:** everything about the business lives in one config file, so a restaurant could drop in dish
>   photos instead of drone footage.
> Budget, quality, on time: now the builder's footage says it for them."

---

## Questions you might get

| Question | Answer |
|---|---|
| How long and how much? | About 4 minutes and about $1 of agent time per 15 s video, plus a few cents of ElevenLabs voice. |
| What does the builder have to do? | Drop footage into Drive, pick a story, optionally type one message. No tagging, sorting or editing. |
| What about privacy? | Shots with people, house numbers or signs are excluded, cropped or blurred automatically, and the agent checks every frame before finishing. |
| Can it make things up? | No. The prompt forbids invented facts. Specs and claims come only from what the builder types, and the description only says what the footage shows. |
| What if the footage is missing something, like no interior shots? | It makes the most honest version it can and says so in its notes, instead of faking it. |
| Music rights? | Tracks come from the builder's own library. Pixabay tracks are cleared for commercial use, and unknown licenses are flagged in red. |
| Why these four stories? | They're reverse-engineered from high-performing real-estate and builder reels: a hook in the first 3 seconds, 15-30 s long, cuts on the beat, and the best shot last. |

## If something goes wrong

- **The live job fails or is slow:** "Agents take a few minutes. Here's the finished one." Then carry on with step 7.
  The pre-made job carries the demo on its own.
- **No sound in the room:** play `data/preview/styles/process15.mp4` from a video player and narrate over it; the
  subtitles carry the voiceover.
- **The page won't load:** restart with `python3 app/server.py` (about 2 seconds). Finished videos survive a restart; a job that was mid-run shows as interrupted, so start it again.
