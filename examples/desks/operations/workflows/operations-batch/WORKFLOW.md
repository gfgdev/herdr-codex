---
{
  "id": "operations-batch",
  "name": "Process and verify a local batch",
  "projectId": "working",
  "teamId": "operations-team",
  "resourceIds": [],
  "steps": [
    {
      "id": "lead",
      "kind": "agent",
      "teamMemberId": "lead",
      "instructions": "Coordinate the supplied records, transformation rules and acceptance checks."
    },
    {
      "id": "inventory",
      "kind": "command",
      "teamMemberId": "processor",
      "command": {
        "argv": [
          "{{node}}",
          "-e",
          "const fs=require('node:fs'),path=require('node:path');const entries=fs.readdirSync('.', {withFileTypes:true}).filter(e=>!e.name.startsWith('.')).map(e=>({name:e.name,kind:e.isFile()?'file':e.isDirectory()?'directory':'other'})).sort((a,b)=>a.name.localeCompare(b.name));fs.writeFileSync(path.join(process.argv[1],'file-manifest.json'),JSON.stringify(entries,null,2)+'\\n');process.stdout.write(JSON.stringify({entries:entries.length})+'\\n');",
          "{{outputs}}"
        ]
      },
      "instructions": "Write a deterministic top-level source file manifest to the assigned outputs directory. Do not modify source files."
    },
    {
      "id": "process",
      "kind": "agent",
      "teamMemberId": "processor",
      "instructions": "Inspect supplied local inputs and rules. Produce proposed normalized outputs and an evidence index; preserve source files.",
      "dependsOn": [
        "inventory"
      ]
    },
    {
      "id": "review",
      "kind": "recipe",
      "teamMemberId": "reviewer",
      "dependsOn": [
        "process"
      ],
      "recipeId": "operations-review",
      "parameters": {
        "proposed_directory": "{{steps.process.outputs}}",
        "outputs": "{{outputs}}"
      }
    }
  ]
}
---

This workflow prepares and reviews proposed local artifacts. Mailbox ingestion, spreadsheet writes, external delivery and live business decisions require separate task-specific authority and connectors.
