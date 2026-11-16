---
{
  "id": "research-brief",
  "name": "Research and source review",
  "projectId": "working",
  "teamId": "research-team",
  "resourceIds": [],
  "steps": [
    {
      "id": "lead",
      "kind": "agent",
      "teamMemberId": "lead",
      "instructions": "Coordinate the question in the provided task inputs and review the team evidence."
    },
    {
      "id": "brief",
      "kind": "recipe",
      "teamMemberId": "analyst",
      "recipeId": "research-brief",
      "parameters": {
        "focus": "answer the supplied question; disclose unresolved source gaps",
        "outputs": "{{outputs}}"
      }
    },
    {
      "id": "review",
      "kind": "review",
      "teamMemberId": "reviewer",
      "dependsOn": [
        "brief"
      ],
      "instructions": "Independently verify the brief and source references at {{steps.brief.outputs}}. Report supported corrections to your supervisor."
    }
  ]
}
---

This starter uses local documents. Web search and external retrieval are separate capabilities and are not implied by this workflow.
