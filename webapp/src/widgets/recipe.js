// Tonight's recipe: one big step at a time, tap Next to advance.
const title = 'Tonight: Spaghetti with Tomato Sauce';
const steps = [
  'Boil a big pot of salted water.',
  'Chop 1 onion and 3 garlic cloves.',
  'Cook the onion in olive oil for 5 minutes.',
  'Add the garlic and a can of tomatoes. Simmer 15 minutes.',
  'Cook the spaghetti for 10 minutes, then drain.',
  'Mix pasta with sauce. Add cheese and eat!',
];

export function mount(el) {
  el.classList.add('card');
  let i = 0;
  el.innerHTML = `
    <h2></h2>
    <div class="recipe-body">
      <div class="recipe-num"></div>
      <div class="recipe-step"></div>
    </div>
    <div class="recipe-btns">
      <button class="recipe-btn recipe-back">Back</button>
      <button class="recipe-btn recipe-next">Next</button>
    </div>`;
  const h = el.querySelector('h2');
  const num = el.querySelector('.recipe-num');
  const step = el.querySelector('.recipe-step');
  const back = el.querySelector('.recipe-back');
  const next = el.querySelector('.recipe-next');
  const draw = () => {
    h.textContent = title;
    num.textContent = `Step ${i + 1} of ${steps.length}`;
    step.textContent = steps[i];
    back.disabled = i === 0;
    next.textContent = i === steps.length - 1 ? 'Start over' : 'Next';
  };
  back.onclick = () => { if (i > 0) { i--; draw(); } };
  next.onclick = () => { i = i === steps.length - 1 ? 0 : i + 1; draw(); };
  draw();
}
