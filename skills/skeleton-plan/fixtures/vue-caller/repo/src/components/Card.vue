<script setup lang="ts">
import { greet } from '../greet';
const text = greet();
</script>

<template>
  <p>{{ text }}</p>
</template>
