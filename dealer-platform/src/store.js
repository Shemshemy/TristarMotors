import { starterCars } from "./data.js";

const KEY = "tristar-platform-v1";
const initialState = () => ({ cars: structuredClone(starterCars), leads: [], favorites: [] });

export function readStore() {
  try {
    const data = JSON.parse(localStorage.getItem(KEY));
    if (data && Array.isArray(data.leads)) {
      return {
        ...initialState(),
        leads: data.leads,
        favorites: Array.isArray(data.favorites) ? data.favorites : [],
      };
    }
  } catch (error) {
    console.warn("Local dealer data could not be read; using sample inventory.", error);
  }
  return initialState();
}

export function writeStore(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ leads: state.leads, favorites: state.favorites }));
    return true;
  } catch (error) {
    console.error("Local dealer data could not be saved.", error);
    return false;
  }
}

export function resetDemoStore() {
  localStorage.removeItem(KEY);
  return initialState();
}
