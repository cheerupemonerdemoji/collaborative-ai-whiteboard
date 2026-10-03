# Canvas Basics

The canvas is the large open area in the middle of every board. It works like a whiteboard that never runs out of space: sketch, write, draw arrows, and arrange ideas however you like.

## Canvas objects vs. semantic entities

This is the single most important idea to understand early.

**Canvas objects** are visual: rectangles, sticky notes, text, drawings, and arrows. They are for thinking out loud, sketching diagrams, and arranging ideas spatially.

**Semantic entities** are structured engineering records — a requirement, an experiment, a decision, a piece of evidence. You create and browse them in the **Semantic Inspector** (the **Semantic** button in the top bar), not on the canvas.

They are separate on purpose:

- Creating a semantic entity does **not** draw anything on the canvas.
- Drawing a shape on the canvas does **not** create an engineering record.
- Deleting a canvas shape does not remove any engineering record, and archiving a record does not remove any shape.

A useful habit: sketch the design on the canvas, and record the engineering facts — requirements, test results, decisions — in the Inspector. Use sticky notes on the canvas to point at things ("see Requirement: Controller stays cool").

## The toolbar

The toolbar at the bottom of the canvas has the tools you will use most. Hover over a tool to see its name and keyboard shortcut.

| Tool | Shortcut | What it does |
|---|---|---|
| Select | V | Click shapes to select them; drag to move; drag a box to select several |
| Hand | H | Drag to move the view around instead of moving shapes |
| Draw | D | Freehand drawing |
| Eraser | E | Rub out drawn strokes |
| Arrow | A | Draw an arrow between points or shapes |
| Text | T | Click anywhere and type |
| Note | N | A sticky note |
| Media | Ctrl + U | Add an image |
| Rectangle | R | A rectangle; **More** has other shapes |

## Creating shapes

1. Choose a tool (for example **Rectangle**).
2. Click and drag on the canvas.
3. The shape appears and stays selected so you can adjust it.

To put text inside a shape, double-click it and type. To add free-floating text, use the **Text** tool and click where you want it.

## Selecting, moving, and resizing

- Click a shape to select it. Selected shapes show handles at the corners.
- Drag a shape to move it. Drag a corner handle to resize it.
- Drag a box across empty canvas to select several shapes at once, then move them together.
- When something is selected, a panel on the side lets you change colour, fill, line style, size, and opacity.

## Arrows

Choose the **Arrow** tool and drag from one place to another. If you start or end the arrow on a shape, it attaches, and follows the shape when you move it.

## Deleting and undoing

Select something and press **Delete** (or **Backspace**), or use the trash button in the small actions bar. Made a mistake? Press **Ctrl + Z** (⌘ + Z on a Mac) to undo and **Ctrl + Shift + Z** to redo.

## Moving around and zooming

- **Scroll** to move around the canvas, or use the **Hand** tool and drag.
- **Ctrl + scroll** (or pinch on a trackpad) to zoom in and out.
- Press **Shift + 1** to zoom so that everything fits on screen. This is handy after a reload if you cannot see your shapes.
- The zoom level is shown at the bottom left.

## Working with other people

When other people have the same board open, you see their cursors moving on the canvas in real time. Changes appear for everyone as they are made. Two people can edit different shapes at once without getting in each other's way.

Whether you can change things depends on your role on the board. **Viewers** can look around and use the Inspector and History to read, but cannot change the canvas. See [Roles & Sharing](roles-and-sharing.md).

## Saving and reloading

You never need to press Save. Every change is stored as you make it. If you reload the page, close the tab, or come back tomorrow, the canvas is exactly as you left it.

One thing to know: after a reload the view may not be positioned where you left it. Press **Shift + 1** to bring everything back into view.

## Presenting

The **Present** button in the top bar hides the editing tools so that the canvas fills the screen — useful in a meeting. Click **Exit presentation** to bring the tools back.

## Sharing a link

**Copy room link** copies the address of the board. Anyone you send it to still needs to be a member of the board to open it. To give someone access, see [Roles & Sharing](roles-and-sharing.md).

## Next

Continue to the [Semantic Inspector](semantic-inspector.md).
