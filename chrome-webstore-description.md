# GitHub HTML Preview

Turn HTML files in GitHub into the documents they were meant to be.

HTML is becoming one of the best ways to share rich, useful work from coding agents: visual implementation plans, design explorations, interactive diagrams, reports, prototypes, and explainers. [Anthropic has written about why HTML can be more expressive, readable, and shareable than Markdown](https://claude.com/blog/using-claude-code-the-unreasonable-effectiveness-of-html). But GitHub normally shows an HTML file as source code, making it harder for the rest of the team to review and use.

GitHub HTML Preview adds a **Preview** button next to **Raw**. Click it and see the finished artifact right where you are, with its layout, styles, charts, illustrations, and interactions intact. Everyone on the team can work from the same committed artifact instead of passing around screenshots, downloads, or links to temporary tools.

## Built for the way teams work now

At [eesel](https://eesel.ai), we use HTML artifacts every day: to plan Linear issues, explore product ideas, review changes, and create documents that humans actually want to read. They are far more expressive than a wall of Markdown, and they make it easier for a team to stay close to an agent’s work instead of handing off a plan that no one opens.

Commit the artifact alongside the work it explains, then let teammates review the same live document in context. Designers, engineers, product managers, and other stakeholders can see the visual result, not just the source, and leave the artifact in the same repository as the issue, PR, or project it belongs to.

As we wrote in [“Does Claude Code make you less of a founder?”](https://www.eesel.ai/blog/does-claude-code-make-you-less-of-a-founder), AI can remove the typing without removing the judgment. People still need to decide what is worth building, check whether the result is right, and own the outcome. A visual, shareable artifact makes that human review easier for everyone involved.

As agents produce more work, human review becomes more important, not less. [Anthropic’s 2026 Agentic Coding Trends Report](https://resources.anthropic.com/hubfs/2026%20Agentic%20Coding%20Trends%20Report.pdf) describes AI development as a collaborative process that still depends on human oversight, validation, and judgment. A rendered HTML artifact gives everyone a faster way to understand what the agent made and decide what happens next.

Use it for:

- Visual plans for issues and projects
- Design mockups and interactive prototypes
- PR explainers, code reviews, and architecture diagrams
- Generated reports, research, and status updates
- Small tools and one-off interfaces built for a specific task

Agents make it practical to create useful things that might never have been worth building by hand, such as an interactive dashboard, a custom comparison tool, or a visual explainer. GitHub HTML Preview makes those one-off artifacts easy for the whole team to open and review.

That means fewer “where is the latest version?” messages, fewer screenshots that go stale, and a clearer shared reference for decisions and reviews.

## Keep your files where they belong

You shouldn’t have to upload a private artifact to another website just to view it, risking a document leak to third-party hosting. Your data stays in your GitHub account or organization for the preview: the extension fetches the file directly from GitHub using your existing session and renders it locally in your browser.

That matters because a document shared through a public AI or hosting link can end up discoverable in places you did not expect. [Axios recently reported on public Claude artifacts appearing in Google search](https://www.axios.com/2026/07/27/anthropic-claude-public-chats-google-search). Keep sensitive plans, reports, and prototypes in the GitHub organization your team already trusts instead.

There is no third-party hosting, proxy, upload, or analytics here. The extension does not send your HTML, repository contents, or GitHub credentials anywhere else. Private repositories and gists work without moving their contents outside GitHub and your browser.

Your source stays in GitHub, under the access controls you already use. The rendered document behaves like any HTML you open in a browser, so external resources requested by the document itself follow normal browser behavior.

## Works with your existing GitHub setup

You don’t need to pay for another hosting service, create another account, or change your GitHub organization settings. Teams, permissions, private repositories, and existing workflows continue to work as they do today.

If you can access an HTML file in GitHub, whether it’s public or private, this extension can visualize it. Your teammates can use the same repository permissions and review the same source of truth without asking an admin to configure another service.

## A preview that fits into GitHub

- Open HTML files inline in a floating, draggable, resizable panel, or switch to fullscreen.
- Match GitHub’s light or dark theme automatically.
- Move between files and keep the preview in sync with the page you’re viewing.
- Right-click an HTML link anywhere on GitHub and choose **Preview HTML**.
- Optionally auto-open HTML artifacts as you browse them.
- Share a link with `#htmlpreview` and the artifact opens in preview mode for your teammate.
- Close the preview without losing your place or line anchor in the file.

The extension is designed to make GitHub a better home for rich team artifacts: commit the HTML once, then let anyone with repository access read, review, and use it as a real document. The repository remains the source of truth, and the rendered view stays close to the code, issue, or pull request it supports.

Install it, open an `.html` file on GitHub, and click **Preview**.
