// Club directory: 3 pages of 5 clubs (?page=1|2|3). Previous and Next are real links, so each
// page is a fresh page load, like a server-rendered list.
(() => {
  const PAGE_SIZE = 5;
  /** Fictional clubs; emails use the reserved .example domain. */
  const CLUBS = [
    ['Robotics Club', 'Asha Rao', 'robotics@clubs.college.example'],
    ['Coding Club', 'Vikram Iyer', 'coding@clubs.college.example'],
    ['Drama Society', 'Meera Nair', 'drama@clubs.college.example'],
    ['Photography Club', 'Arjun Mehta', 'photo@clubs.college.example'],
    ['Music Circle', 'Sana Qureshi', 'music@clubs.college.example'],
    ['Literary Society', 'Rohan Das', 'literary@clubs.college.example'],
    ['Astronomy Club', 'Priya Menon', 'astro@clubs.college.example'],
    ['Entrepreneurship Cell', 'Kabir Singh', 'ecell@clubs.college.example'],
    ['Debate Society', 'Ananya Ghosh', 'debate@clubs.college.example'],
    ['Nature and Trekking Club', 'Dev Patel', 'trek@clubs.college.example'],
    ['Quiz Club', 'Ishita Bose', 'quiz@clubs.college.example'],
    ['Dance Crew', 'Nikhil Reddy', 'dance@clubs.college.example'],
    ['Chess Club', 'Farah Khan', 'chess@clubs.college.example'],
    ['Film Society', 'Aditya Kulkarni', 'film@clubs.college.example'],
    ['Social Service League', 'Lakshmi Pillai', 'service@clubs.college.example']
  ];

  const pages = Math.ceil(CLUBS.length / PAGE_SIZE);
  const page = Math.min(pages, Math.max(1, Number(new URLSearchParams(location.search).get('page')) || 1));
  document.title = `College Club Directory — Page ${page} of ${pages} — Sahayak practice`;

  document.getElementById('clubs').replaceChildren(...CLUBS.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map(([club, person, email]) => {
    const tr = document.createElement('tr');
    const name = document.createElement('td');
    name.textContent = club;
    const who = document.createElement('td');
    who.textContent = person;
    const mail = document.createElement('td');
    const a = document.createElement('a');
    a.href = `mailto:${email}`;
    a.textContent = email;
    mail.append(a);
    tr.append(name, who, mail);
    return tr;
  }));

  document.getElementById('page-info').textContent = `Page ${page} of ${pages}`;
  // On the first and last page the link that goes nowhere is removed, not just greyed out.
  const prev = document.getElementById('prev');
  const next = document.getElementById('next');
  if (page > 1) prev.setAttribute('href', `?page=${page - 1}`);
  else prev.remove();
  if (page < pages) next.setAttribute('href', `?page=${page + 1}`);
  else next.remove();
})();
