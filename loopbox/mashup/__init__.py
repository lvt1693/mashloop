"""Mashups: a new song made from several, rendered on the server.

plan.py decides what plays when (one tempo, one key and one mood for the
whole song, a form from intro to outro, and for every section which song
sings and which plays); render.py makes the sound (each clip warped beat by
beat onto the common tempo and moved into the common key with Rubber Band,
then mixed with the DJ moves and the chosen vibe, and mastered); store.py
keeps the result for 48 hours, readable only with the token its creator got.
"""
