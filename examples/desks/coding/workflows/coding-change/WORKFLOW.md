---
{
  "id": "coding-change",
  "name": "Scoped code change",
  "projectId": "working",
  "teamId": "coding-team",
  "resourceIds": [],
  "steps": [
    {
      "id": "lead",
      "kind": "agent",
      "teamMemberId": "lead",
      "instructions": "Coordinate the supplied task using its input context. Review child outcomes before consolidating the result."
    },
    {
      "id": "implement",
      "kind": "agent",
      "teamMemberId": "implementer",
      "instructions": "Implement the supplied task and verify it. Record checks in your evidence directory."
    },
    {
      "id": "review",
      "kind": "recipe",
      "teamMemberId": "reviewer",
      "dependsOn": [
        "implement"
      ],
      "recipeId": "coding-review",
      "parameters": {
        "evidence_directory": "{{steps.implement.evidence}}",
        "focus": "correctness, scope and reported verification",
        "outputs": "{{outputs}}"
      }
    }
  ]
}
---

Use a disposable or explicitly authorized checkout for the first trial. The implementer is the only checkout writer. No test command is guessed for an unfamiliar repository.
