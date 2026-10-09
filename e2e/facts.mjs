// 20 facts and, for each, a question in other words. The E2E test stores the
// facts and checks that each question finds its fact in the top 3.
export const FACTS = [
  { text: "I take my coffee with oat milk and no sugar.", kind: "preference", ask: "How do I like my coffee?" },
  { text: "My sister Leila lives in Vancouver.", kind: "fact", ask: "Which city is my sister in?" },
  { text: "I am allergic to peanuts.", kind: "fact", ask: "What food can make me sick?" },
  { text: "My passport expires in March 2027.", kind: "fact", ask: "When does my travel document run out?" },
  { text: "Renew the car insurance before the end of November.", kind: "task-note", ask: "What do I need to do about my vehicle policy?" },
  { text: "I prefer window seats on flights.", kind: "preference", ask: "Where do I like to sit on a plane?" },
  { text: "My dentist is Dr. Okafor on Queen Street.", kind: "fact", ask: "Who looks after my teeth?" },
  { text: "I run 5 km every Tuesday and Thursday morning.", kind: "fact", ask: "What exercise do I do during the week?" },
  { text: "Our wifi password is on the fridge door.", kind: "fact", ask: "Where can I find the internet login?" },
  { text: "I write in Python at work and Rust at home.", kind: "fact", ask: "Which programming languages do I use?" },
  { text: "Send the quarterly report to Maria by Friday.", kind: "task-note", ask: "What is due for Maria this week?" },
  { text: "I am vegetarian and do not eat fish.", kind: "preference", ask: "What is my diet?" },
  { text: "My bike is a green Trek hybrid with a broken bell.", kind: "fact", ask: "Describe my bicycle." },
  { text: "I want replies in short sentences without emoji.", kind: "preference", ask: "How should answers to me be written?" },
  { text: "The kids have swimming lessons on Saturday at 10.", kind: "fact", ask: "When do the children go to the pool?" },
  { text: "Book a table for our anniversary on June 14.", kind: "task-note", ask: "What should I reserve for the wedding date celebration?" },
  { text: "My favourite author is Ursula K. Le Guin.", kind: "preference", ask: "Which writer do I like best?" },
  { text: "I work from home on Mondays and Fridays.", kind: "fact", ask: "Which days am I not in the office?" },
  { text: "The spare house key is with the neighbour at number 12.", kind: "fact", ask: "Who has an extra key to my place?" },
  { text: "I use a standing desk and a split keyboard.", kind: "fact", ask: "What is my desk setup like?" },
];
