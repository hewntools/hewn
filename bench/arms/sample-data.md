### sample/calls.json

Sample data: what the tool looks like in use. When you create a tool, write one:

```json
[
  { "operation": "add_plant", "input": { "name": "Monstera", "room": "Living room" } },
  { "operation": "log_watering", "input": { "plant_id": 1, "date": "2026-10-20" } }
]
```

10–40 calls, in order. They replay on an empty database as the owner: plain writes only. Use
made-up names, places and dates that look real (spread over recent weeks, relative to today) and
fill the UI and its visuals well, with enough history for trends and a mix of states (due, late,
done). Ids start at 1 in the order things are added.

